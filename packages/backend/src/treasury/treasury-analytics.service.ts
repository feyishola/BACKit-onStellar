import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import {
  bucketLabels,
  BucketInterval,
  DEFAULT_INTERVAL,
  FeeSplitAmounts,
  FeeSplitBps,
  fillSeries,
  fromUnits,
  growthPct,
  isInterval,
  isRange,
  normalizeDecimal,
  parseFeeSplit,
  resolveWindow,
  sharePct,
  splitFee,
  sqlBucketLabel,
  TimeseriesRange,
  TimeseriesWindow,
  toUtcTimestampLiteral,
} from '../analytics/timeseries';

export const TREASURY_ANALYTICS_REDIS = Symbol('TREASURY_ANALYTICS_REDIS');

export const OVERVIEW_CACHE_TTL_SECONDS = 300;
const LOCK_TTL_MS = 15_000;
/** Waiters give up shortly before the lock would expire on its own. */
const LOCK_WAIT_MS = 12_000;
const LOCK_POLL_MS = 50;
const CACHE_VERSION = 'v1';
const RETENTION_WEEKS = 8;
const TOP_MARKETS = 10;

/** Combinations kept permanently warm so dashboard loads always hit Redis. */
export const WARM_COMBINATIONS: ReadonlyArray<
  [TimeseriesRange, BucketInterval]
> = [
  ['24h', 'hour'],
  ['7d', 'hour'],
  ['7d', 'day'],
  ['30d', 'day'],
  ['90d', 'day'],
  ['1y', 'day'],
];

export interface Metric {
  current: string;
  previous: string;
  growthPct: number | null;
}

export interface CountMetric {
  current: number;
  previous: number;
  growthPct: number | null;
}

export interface TreasuryOverview {
  range: TimeseriesRange;
  interval: BucketInterval;
  from: string;
  to: string;
  generatedAt: string;
  feeSplitBps: FeeSplitBps;
  /** Chart.js-ready: `labels` aligns index-for-index with every series array. */
  labels: string[];
  series: {
    tvl: string[];
    volume: string[];
    stakes: number[];
    activeUsers: number[];
    newUsers: number[];
    fees: {
      total: string[];
      treasury: string[];
      creator: string[];
      buyback: string[];
      burn: string[];
    };
  };
  summary: {
    tvl: Metric;
    volume: Metric;
    fees: Metric & { split: FeeSplitAmounts };
    activeUsers: CountMetric;
    newUsers: CountMetric;
  };
  markets: {
    topCalls: Array<{
      callId: string;
      title: string;
      token: string;
      volume: string;
      participants: number;
      sharePct: number;
    }>;
    byToken: Array<{ token: string; volume: string; sharePct: number }>;
  };
  retention: {
    cohorts: Array<{
      cohort: string;
      size: number;
      /** % of the cohort active in week N after their first stake (index 0 = 100). */
      retention: number[];
    }>;
  };
}

interface BucketRow {
  bucket: string;
  [k: string]: unknown;
}

/**
 * BE-033 — protocol TVL, volume, fee revenue and cohort retention time
 * series, bucketed hourly/daily with date_trunc and cached in Redis.
 */
@Injectable()
export class TreasuryAnalyticsService implements OnModuleDestroy {
  private readonly logger = new Logger(TreasuryAnalyticsService.name);
  private readonly feeSplit = parseFeeSplit(process.env.TREASURY_FEE_SPLIT_BPS);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(TREASURY_ANALYTICS_REDIS) private readonly redis: Redis,
  ) {}

  onModuleDestroy() {
    this.redis.disconnect();
  }

  static cacheKey(range: TimeseriesRange, interval: BucketInterval) {
    return `treasury:analytics:overview:${CACHE_VERSION}:${range}:${interval}`;
  }

  /** Validates query params into a range/interval pair. */
  static parseQuery(range?: string, interval?: string) {
    const r = range ?? '30d';
    if (!isRange(r)) {
      throw new BadRequestException(
        'range must be one of 24h, 7d, 30d, 90d, 1y',
      );
    }
    const i = interval ?? DEFAULT_INTERVAL[r];
    if (!isInterval(i)) {
      throw new BadRequestException('interval must be hour or day');
    }
    try {
      resolveWindow(r, i);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { range: r, interval: i };
  }

  /**
   * Cache-aside with a Redis single-flight lock: concurrent misses wait for
   * the first computation instead of stampeding Postgres. Redis being down
   * degrades to direct computation rather than failing the request.
   */
  async getOverview(
    range: TimeseriesRange,
    interval: BucketInterval,
  ): Promise<TreasuryOverview> {
    const key = TreasuryAnalyticsService.cacheKey(range, interval);
    const cached = await this.readCache(key);
    if (cached) return cached;

    const lockKey = `${key}:lock`;
    const token = `${process.pid}:${Date.now()}:${Math.random()}`;
    const lock = await this.tryLock(lockKey, token);
    if (lock === 'busy') {
      const waited = await this.waitForCache(key);
      if (waited) return waited;
    }

    try {
      return await this.computeAndStore(key, range, interval);
    } finally {
      if (lock === 'acquired') await this.releaseLock(lockKey, token);
    }
  }

  /** Recomputes the warm set before the 5-minute TTL lapses. */
  @Cron('0 */4 * * * *', { name: 'treasury-analytics-warm', timeZone: 'UTC' })
  async warmCache(): Promise<void> {
    for (const [range, interval] of WARM_COMBINATIONS) {
      try {
        await this.computeAndStore(
          TreasuryAnalyticsService.cacheKey(range, interval),
          range,
          interval,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to warm ${range}/${interval}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async computeAndStore(
    key: string,
    range: TimeseriesRange,
    interval: BucketInterval,
  ): Promise<TreasuryOverview> {
    const overview = await this.computeOverview(resolveWindow(range, interval));
    try {
      await this.redis.set(
        key,
        JSON.stringify(overview),
        'EX',
        OVERVIEW_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `Overview cache write failed: ${(err as Error).message}`,
      );
    }
    return overview;
  }

  private async readCache(key: string): Promise<TreasuryOverview | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as TreasuryOverview) : null;
    } catch {
      return null;
    }
  }

  /** 'unavailable' means Redis is down: compute directly instead of waiting. */
  private async tryLock(
    lockKey: string,
    token: string,
  ): Promise<'acquired' | 'busy' | 'unavailable'> {
    try {
      const res = await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX');
      return res === 'OK' ? 'acquired' : 'busy';
    } catch {
      return 'unavailable';
    }
  }

  /** Compare-and-delete so a slow holder never frees someone else's lock. */
  private async releaseLock(lockKey: string, token: string): Promise<void> {
    try {
      await this.redis.eval(
        `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
        1,
        lockKey,
        token,
      );
    } catch {
      // Lock expires on its own.
    }
  }

  private async waitForCache(key: string): Promise<TreasuryOverview | null> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
      const hit = await this.readCache(key);
      if (hit) return hit;
    }
    return null;
  }

  // ─── aggregation ─────────────────────────────────────────────────────────

  async computeOverview(window: TimeseriesWindow): Promise<TreasuryOverview> {
    const labels = bucketLabels(window);
    const from = toUtcTimestampLiteral(window.from);
    const to = toUtcTimestampLiteral(window.to);
    const prevFrom = toUtcTimestampLiteral(window.previousFrom);
    // Whitelisted by isInterval(); inlined so the planner sees a constant.
    const unit = window.interval;
    const bucket = (col: string) =>
      sqlBucketLabel(`date_trunc('${unit}', ${col})`);

    const [
      activityRows,
      newUserRows,
      tvlRows,
      feeRows,
      totals,
      topCalls,
      byToken,
      retentionRows,
    ] = await Promise.all([
      this.query<BucketRow>(
        `SELECT ${bucket('s."createdAt"')} AS bucket,
                SUM(s.amount)::text AS volume,
                COUNT(*)::int AS stakes,
                COUNT(DISTINCT s."userAddress")::int AS active_users
         FROM stakes s
         WHERE s."createdAt" >= $1::timestamp AND s."createdAt" < $2::timestamp
         GROUP BY 1`,
        [from, to],
      ),
      // First-ever stakes inside [prevFrom, to): scan only the window and
      // probe the (userAddress, createdAt) index for any earlier stake.
      this.query<BucketRow>(
        `SELECT ${bucket('w.first_at')} AS bucket, COUNT(*)::int AS new_users
         FROM (
           SELECT s."userAddress", MIN(s."createdAt") AS first_at
           FROM stakes s
           WHERE s."createdAt" >= $1::timestamp AND s."createdAt" < $2::timestamp
           GROUP BY 1
         ) w
         WHERE NOT EXISTS (
           SELECT 1 FROM stakes p
           WHERE p."userAddress" = w."userAddress" AND p."createdAt" < $1::timestamp
         )
         GROUP BY 1`,
        [prevFrom, to],
      ),
      // TVL at the end of each bucket = TVL at window start + running sum of
      // stake inflows minus stakes released when their call resolved.
      this.query<BucketRow>(
        `WITH base AS (
           SELECT COALESCE(SUM(s.amount), 0) AS v
           FROM stakes s JOIN calls c ON c.id = s."callId"
           WHERE s."createdAt" < $1::timestamp
             AND (c."resolvedAt" IS NULL OR c."resolvedAt" >= $1::timestamp)
         ), deltas AS (
           SELECT date_trunc('${unit}', s."createdAt") AS b, SUM(s.amount) AS d
           FROM stakes s
           WHERE s."createdAt" >= $1::timestamp AND s."createdAt" < $2::timestamp
           GROUP BY 1
           UNION ALL
           SELECT date_trunc('${unit}', c."resolvedAt"), -SUM(s.amount)
           FROM stakes s JOIN calls c ON c.id = s."callId"
           WHERE c."resolvedAt" >= $1::timestamp AND c."resolvedAt" < $2::timestamp
             AND s."createdAt" < c."resolvedAt"
           GROUP BY 1
         ), series AS (
           SELECT g AS b FROM generate_series(
             $1::timestamp, $2::timestamp - interval '1 ${unit}', interval '1 ${unit}'
           ) g
         ), per_bucket AS (
           SELECT series.b, COALESCE(SUM(deltas.d), 0) AS d
           FROM series LEFT JOIN deltas ON deltas.b = series.b
           GROUP BY series.b
         )
         SELECT ${sqlBucketLabel('per_bucket.b')} AS bucket,
                ((SELECT v FROM base) + SUM(per_bucket.d) OVER (ORDER BY per_bucket.b))::text AS tvl,
                (SELECT v FROM base)::text AS base
         FROM per_bucket`,
        [from, to],
      ),
      this.query<BucketRow>(
        `SELECT ${bucket('t."collectedAt"')} AS bucket, SUM(t."feeAmount")::text AS fees
         FROM treasury_entries t
         WHERE t."collectedAt" >= $1::timestamp AND t."collectedAt" < $2::timestamp
         GROUP BY 1`,
        [from, to],
      ),
      this.query<Record<string, string | number>>(
        `SELECT
           (SELECT COALESCE(SUM(amount), 0)::text FROM stakes
             WHERE "createdAt" >= $2::timestamp AND "createdAt" < $3::timestamp) AS volume,
           (SELECT COALESCE(SUM(amount), 0)::text FROM stakes
             WHERE "createdAt" >= $1::timestamp AND "createdAt" < $2::timestamp) AS prev_volume,
           (SELECT COUNT(DISTINCT "userAddress")::int FROM stakes
             WHERE "createdAt" >= $2::timestamp AND "createdAt" < $3::timestamp) AS active_users,
           (SELECT COUNT(DISTINCT "userAddress")::int FROM stakes
             WHERE "createdAt" >= $1::timestamp AND "createdAt" < $2::timestamp) AS prev_active_users,
           (SELECT COALESCE(SUM("feeAmount"), 0)::text FROM treasury_entries
             WHERE "collectedAt" >= $2::timestamp AND "collectedAt" < $3::timestamp) AS fees,
           (SELECT COALESCE(SUM("feeAmount"), 0)::text FROM treasury_entries
             WHERE "collectedAt" >= $1::timestamp AND "collectedAt" < $2::timestamp) AS prev_fees`,
        [prevFrom, from, to],
      ),
      this.query<Record<string, string | number>>(
        `SELECT c.id::text AS call_id, c.title,
                COALESCE(c."stakeToken", 'NATIVE') AS token,
                SUM(s.amount)::text AS volume,
                COUNT(DISTINCT s."userAddress")::int AS participants
         FROM stakes s JOIN calls c ON c.id = s."callId"
         WHERE s."createdAt" >= $1::timestamp AND s."createdAt" < $2::timestamp
         GROUP BY c.id
         ORDER BY SUM(s.amount) DESC, c.id
         LIMIT ${TOP_MARKETS}`,
        [from, to],
      ),
      this.query<Record<string, string>>(
        `SELECT COALESCE(c."stakeToken", 'NATIVE') AS token, SUM(s.amount)::text AS volume
         FROM stakes s JOIN calls c ON c.id = s."callId"
         WHERE s."createdAt" >= $1::timestamp AND s."createdAt" < $2::timestamp
         GROUP BY 1
         ORDER BY SUM(s.amount) DESC, 1`,
        [from, to],
      ),
      this.retentionQuery(window.to),
    ]);

    // ── series ──
    const byBucket = <T>(rows: BucketRow[], pick: (r: BucketRow) => T) =>
      new Map(rows.map((r) => [r.bucket, pick(r)]));

    const volume = fillSeries(
      labels,
      byBucket(activityRows, (r) => normalizeDecimal(r.volume as string)),
      fromUnits(0n),
    );
    const stakes = fillSeries(
      labels,
      byBucket(activityRows, (r) => Number(r.stakes)),
      0,
    );
    const activeUsers = fillSeries(
      labels,
      byBucket(activityRows, (r) => Number(r.active_users)),
      0,
    );
    const newUsers = fillSeries(
      labels,
      byBucket(newUserRows, (r) => Number(r.new_users)),
      0,
    );
    const tvl = fillSeries(
      labels,
      byBucket(tvlRows, (r) => normalizeDecimal(r.tvl as string)),
      fromUnits(0n),
    );
    const feeSplits = fillSeries(
      labels,
      byBucket(feeRows, (r) => splitFee(r.fees as string, this.feeSplit)),
      splitFee('0', this.feeSplit),
    );

    // ── summary ──
    const t = totals[0] ?? {};
    const currentTvl = tvl[tvl.length - 1] ?? fromUnits(0n);
    // TVL at the start of this window is, by definition, the previous window's closing TVL.
    const prevTvl = normalizeDecimal(tvlRows[0]?.base as string);
    const currentVolume = normalizeDecimal(t.volume as string);
    const prevVolume = normalizeDecimal(t.prev_volume as string);
    const currentFees = normalizeDecimal(t.fees as string);
    const prevFees = normalizeDecimal(t.prev_fees as string);
    const newUsersTotal = newUsers.reduce((a, b) => a + b, 0);
    // The new-users query spans both windows; buckets before labels[0] are the previous one.
    const prevNewUsers = newUserRows
      .filter((r) => r.bucket < labels[0])
      .reduce((a, r) => a + Number(r.new_users), 0);
    const count = (cur: number, prev: number): CountMetric => ({
      current: cur,
      previous: prev,
      growthPct: growthPct(String(cur), String(prev)),
    });

    const windowVolume = currentVolume;
    return {
      range: window.range,
      interval: window.interval,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      generatedAt: new Date().toISOString(),
      feeSplitBps: this.feeSplit,
      labels,
      series: {
        tvl,
        volume,
        stakes,
        activeUsers,
        newUsers,
        fees: {
          total: feeSplits.map((f) => f.total),
          treasury: feeSplits.map((f) => f.treasury),
          creator: feeSplits.map((f) => f.creator),
          buyback: feeSplits.map((f) => f.buyback),
          burn: feeSplits.map((f) => f.burn),
        },
      },
      summary: {
        tvl: {
          current: currentTvl,
          previous: prevTvl,
          growthPct: growthPct(currentTvl, prevTvl),
        },
        volume: {
          current: currentVolume,
          previous: prevVolume,
          growthPct: growthPct(currentVolume, prevVolume),
        },
        fees: {
          current: currentFees,
          previous: prevFees,
          growthPct: growthPct(currentFees, prevFees),
          split: splitFee(currentFees, this.feeSplit),
        },
        activeUsers: count(
          Number(t.active_users ?? 0),
          Number(t.prev_active_users ?? 0),
        ),
        newUsers: count(newUsersTotal, prevNewUsers),
      },
      markets: {
        topCalls: topCalls.map((r) => ({
          callId: String(r.call_id),
          title: String(r.title),
          token: String(r.token),
          volume: normalizeDecimal(r.volume as string),
          participants: Number(r.participants),
          sharePct: sharePct(r.volume as string, windowVolume),
        })),
        byToken: byToken.map((r) => ({
          token: r.token,
          volume: normalizeDecimal(r.volume),
          sharePct: sharePct(r.volume, windowVolume),
        })),
      },
      retention: { cohorts: this.shapeRetention(retentionRows) },
    };
  }

  /**
   * Weekly first-stake cohorts over the last RETENTION_WEEKS weeks. Only
   * stakes inside that span are scanned; users with any earlier stake are
   * excluded via an index probe, so cost tracks recent activity, not history.
   */
  private retentionQuery(windowEnd: Date) {
    return this.query<{ cohort: string; week_offset: number; users: number }>(
      `WITH bounds AS (
         SELECT date_trunc('week', $1::timestamp) - interval '${RETENTION_WEEKS - 1} weeks' AS start
       ), acts AS (
         SELECT DISTINCT s."userAddress" AS u, date_trunc('week', s."createdAt") AS wk
         FROM stakes s, bounds
         WHERE s."createdAt" >= bounds.start AND s."createdAt" < $2::timestamp
       ), firsts AS (
         SELECT a.u, MIN(a.wk) AS cohort
         FROM acts a
         GROUP BY a.u
         HAVING NOT EXISTS (
           SELECT 1 FROM stakes p, bounds
           WHERE p."userAddress" = a.u AND p."createdAt" < bounds.start
         )
       )
       SELECT ${sqlBucketLabel('f.cohort')} AS cohort,
              (EXTRACT(EPOCH FROM (a.wk - f.cohort)) / 604800)::int AS week_offset,
              COUNT(*)::int AS users
       FROM firsts f
       JOIN acts a ON a.u = f.u
       GROUP BY f.cohort, a.wk
       ORDER BY f.cohort, week_offset`,
      [
        toUtcTimestampLiteral(new Date(windowEnd.getTime() - 1)),
        toUtcTimestampLiteral(windowEnd),
      ],
    );
  }

  private shapeRetention(
    rows: Array<{ cohort: string; week_offset: number; users: number }>,
  ): TreasuryOverview['retention']['cohorts'] {
    const cohorts = new Map<string, Map<number, number>>();
    for (const r of rows) {
      const m = cohorts.get(r.cohort) ?? new Map<number, number>();
      m.set(Number(r.week_offset), Number(r.users));
      cohorts.set(r.cohort, m);
    }
    return [...cohorts.entries()].map(([cohort, weeks]) => {
      const size = weeks.get(0) ?? 0;
      const maxWeek = Math.max(...weeks.keys());
      const retention = Array.from({ length: maxWeek + 1 }, (_, w) =>
        size
          ? Number((BigInt(weeks.get(w) ?? 0) * 10_000n) / BigInt(size)) / 100
          : 0,
      );
      return { cohort, size, retention };
    });
  }

  private query<T>(sql: string, params: unknown[]): Promise<T[]> {
    return this.dataSource.query<T[]>(sql, params);
  }
}
