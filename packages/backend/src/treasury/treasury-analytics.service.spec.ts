import { BadRequestException } from '@nestjs/common';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { resolveWindow } from '../analytics/timeseries';
import {
  OVERVIEW_CACHE_TTL_SECONDS,
  TreasuryAnalyticsService,
  TreasuryOverview,
  WARM_COMBINATIONS,
} from './treasury-analytics.service';

const NOW = new Date('2026-01-15T10:30:00.000Z');
const H = (h: string) => `2026-01-15T${h}:00:00.000Z`;

/** Routes each overview query to canned rows by a distinctive SQL fragment. */
function fixtureQuery(sql: string): unknown[] {
  if (sql.includes('active_users') && sql.includes('GROUP BY 1')) {
    return [
      { bucket: H('02'), volume: '75', stakes: 2, active_users: 2 },
      { bucket: H('04'), volume: '10', stakes: 1, active_users: 1 },
    ];
  }
  if (sql.includes('new_users')) {
    return [
      { bucket: '2026-01-13T12:00:00.000Z', new_users: 1 }, // previous window
      { bucket: H('02'), new_users: 1 },
      { bucket: H('04'), new_users: 1 },
    ];
  }
  if (sql.includes('WITH base AS')) {
    return [
      { bucket: '2026-01-14T11:00:00.000Z', tvl: '101', base: '101' },
      { bucket: H('10'), tvl: '77', base: '101' },
    ];
  }
  if (sql.includes('treasury_entries t')) {
    return [{ bucket: H('03'), fees: '10.0000001' }];
  }
  if (sql.includes('AS prev_volume')) {
    return [
      {
        volume: '86',
        prev_volume: '100',
        active_users: 4,
        prev_active_users: 1,
        fees: '10.0000001',
        prev_fees: '4',
      },
    ];
  }
  if (sql.includes('AS call_id')) {
    return [
      {
        call_id: 'a',
        title: 'Market A',
        token: 'USDC',
        volume: '76',
        participants: 3,
      },
    ];
  }
  if (sql.includes('AS token, SUM')) {
    return [{ token: 'USDC', volume: '76' }];
  }
  if (sql.includes('week_offset')) {
    return [
      { cohort: '2026-01-05T00:00:00.000Z', week_offset: 0, users: 4 },
      { cohort: '2026-01-05T00:00:00.000Z', week_offset: 1, users: 1 },
      { cohort: '2026-01-05T00:00:00.000Z', week_offset: 2, users: 3 },
    ];
  }
  return [];
}

function makeRedis() {
  const store = new Map<string, string>();
  const redis = {
    store,
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: jest.fn((k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(k)) return Promise.resolve(null);
      store.set(k, v);
      return Promise.resolve('OK');
    }),
    eval: jest.fn(() => Promise.resolve(1)),
    disconnect: jest.fn(),
  };
  return redis;
}

describe('TreasuryAnalyticsService (BE-033)', () => {
  let dataSource: {
    query: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
  };
  let redis: ReturnType<typeof makeRedis>;
  let service: TreasuryAnalyticsService;

  beforeEach(() => {
    dataSource = {
      query: jest.fn((sql: string) => Promise.resolve(fixtureQuery(sql))),
    };
    redis = makeRedis();
    service = new TreasuryAnalyticsService(
      dataSource as unknown as DataSource,
      redis as unknown as Redis,
    );
  });

  describe('computeOverview', () => {
    let o: TreasuryOverview;
    beforeEach(async () => {
      o = await service.computeOverview(resolveWindow('24h', 'hour', NOW));
    });

    it('returns Chart.js-aligned arrays for every bucket', () => {
      expect(o.labels).toHaveLength(24);
      for (const arr of [
        o.series.tvl,
        o.series.volume,
        o.series.stakes,
        o.series.activeUsers,
        o.series.newUsers,
        o.series.fees.total,
        o.series.fees.treasury,
      ]) {
        expect(arr).toHaveLength(24);
      }
      const i = o.labels.indexOf(H('02'));
      expect(o.series.volume[i]).toBe('75.0000000');
      expect(o.series.volume[0]).toBe('0.0000000');
      expect(o.series.stakes[i]).toBe(2);
    });

    it('computes growth against the previous equal-length window', () => {
      expect(o.summary.volume).toEqual({
        current: '86.0000000',
        previous: '100.0000000',
        growthPct: -14,
      });
      expect(o.summary.tvl).toEqual({
        current: '77.0000000',
        previous: '101.0000000',
        growthPct: -23.76,
      });
      expect(o.summary.activeUsers).toEqual({
        current: 4,
        previous: 1,
        growthPct: 300,
      });
      expect(o.summary.newUsers).toEqual({
        current: 2,
        previous: 1,
        growthPct: 100,
      });
    });

    it('splits fee revenue between treasury and creators without dust loss', () => {
      expect(o.summary.fees.split).toEqual({
        total: '10.0000001',
        treasury: '5.0000000',
        creator: '2.5000000',
        buyback: '1.5000000',
        burn: '1.0000001',
      });
      expect(o.series.fees.creator[o.labels.indexOf(H('03'))]).toBe(
        '2.5000000',
      );
      expect(o.feeSplitBps.treasury).toBe(5000);
    });

    it('breaks volume down by market and token', () => {
      expect(o.markets.topCalls[0]).toEqual({
        callId: 'a',
        title: 'Market A',
        token: 'USDC',
        volume: '76.0000000',
        participants: 3,
        sharePct: 88.37,
      });
      expect(o.markets.byToken).toEqual([
        { token: 'USDC', volume: '76.0000000', sharePct: 88.37 },
      ]);
    });

    it('shapes cohort retention as percentages of cohort size', () => {
      expect(o.retention.cohorts).toEqual([
        {
          cohort: '2026-01-05T00:00:00.000Z',
          size: 4,
          retention: [100, 25, 75],
        },
      ]);
    });

    it('binds window bounds as zone-less UTC literals and whitelists the unit', () => {
      const activity = dataSource.query.mock.calls.find(([sql]) =>
        sql.includes('active_users'),
      )!;
      expect(activity[0]).toContain(`date_trunc('hour', s."createdAt")`);
      expect(activity[1]).toEqual([
        '2026-01-14T11:00:00.000',
        '2026-01-15T11:00:00.000',
      ]);
    });
  });

  describe('caching', () => {
    it('serves a cache hit without touching Postgres', async () => {
      const key = TreasuryAnalyticsService.cacheKey('30d', 'day');
      redis.store.set(key, JSON.stringify({ range: '30d', cached: true }));

      const res = await service.getOverview('30d', 'day');

      expect(res).toEqual({ range: '30d', cached: true });
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('computes on a miss, stores with a 5 minute TTL, and releases its lock', async () => {
      await service.getOverview('24h', 'hour');

      const key = TreasuryAnalyticsService.cacheKey('24h', 'hour');
      expect(redis.set).toHaveBeenCalledWith(
        `${key}:lock`,
        expect.any(String),
        'PX',
        expect.any(Number),
        'NX',
      );
      expect(redis.set).toHaveBeenCalledWith(
        key,
        expect.any(String),
        'EX',
        OVERVIEW_CACHE_TTL_SECONDS,
      );
      expect(OVERVIEW_CACHE_TTL_SECONDS).toBe(300);
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('del'"),
        1,
        `${key}:lock`,
        expect.any(String),
      );
    });

    it('waits for the lock holder instead of recomputing', async () => {
      const key = TreasuryAnalyticsService.cacheKey('7d', 'day');
      redis.store.set(`${key}:lock`, 'someone-else');
      setTimeout(
        () => redis.store.set(key, JSON.stringify({ range: '7d' })),
        120,
      );

      const res = await service.getOverview('7d', 'day');

      expect(res).toEqual({ range: '7d' });
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('falls back to direct computation when Redis is down', async () => {
      redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
      redis.set.mockRejectedValue(new Error('ECONNREFUSED'));

      const started = Date.now();
      const res = await service.getOverview('24h', 'hour');

      expect(res.labels).toHaveLength(24);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('warms every dashboard default', async () => {
      await service.warmCache();
      for (const [r, i] of WARM_COMBINATIONS) {
        expect(redis.store.has(TreasuryAnalyticsService.cacheKey(r, i))).toBe(
          true,
        );
      }
    });
  });

  describe('parseQuery', () => {
    it('defaults to 30d daily and picks a per-range default interval', () => {
      expect(TreasuryAnalyticsService.parseQuery()).toEqual({
        range: '30d',
        interval: 'day',
      });
      expect(TreasuryAnalyticsService.parseQuery('24h')).toEqual({
        range: '24h',
        interval: 'hour',
      });
    });

    it.each([
      ['5y', undefined],
      ['7d', 'minute'],
      ['90d', 'hour'],
    ])('rejects range=%s interval=%s', (range, interval) => {
      expect(() =>
        TreasuryAnalyticsService.parseQuery(range, interval),
      ).toThrow(BadRequestException);
    });
  });
});
