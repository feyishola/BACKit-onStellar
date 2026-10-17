import { DataSource } from 'typeorm';
import { ReputationDecayService } from './reputation-decay.service';
import { ReputationController } from './reputation.controller';

const AS_OF = new Date('2026-10-18T00:00:00.000Z');

function makeRunner(opts: {
  locked?: boolean;
  batches?: unknown[][];
  maxVolumes?: unknown[];
}) {
  const batches = [...(opts.batches ?? [])];
  const calls: { sql: string; params?: unknown[] }[] = [];
  const runner = {
    connect: jest.fn(),
    release: jest.fn(),
    query: jest.fn((sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock'))
        return Promise.resolve([{ locked: opts.locked ?? true }]);
      if (sql.includes('GROUP BY category'))
        return Promise.resolve(opts.maxVolumes ?? []);
      if (sql.includes('WHERE user_address IN'))
        return Promise.resolve(batches.shift() ?? []);
      return Promise.resolve([]);
    }),
  };
  const dataSource = {
    createQueryRunner: () => runner,
  } as unknown as DataSource;
  return { runner, calls, service: new ReputationDecayService(dataSource) };
}

describe('ReputationDecayService (BE-032)', () => {
  it('skips when another replica holds the advisory lock', async () => {
    const { service, calls, runner } = makeRunner({ locked: false });

    const result = await service.run(AS_OF);

    expect(result.skipped).toBe(true);
    expect(calls).toHaveLength(1);
    expect(runner.release).toHaveBeenCalled();
  });

  it('aggregates in SQL, scores in memory and upserts the JSONB breakdown', async () => {
    const { service, calls } = makeRunner({
      maxVolumes: [
        { category: 'DEFI', max_volume: '10000' },
        { category: null, max_volume: '10000' },
      ],
      batches: [
        [
          {
            user_address: 'GA',
            category: 'DEFI',
            resolved: 30,
            wins: 24,
            volume: '10000',
            last_active: '2026-07-20T00:00:00.000Z', // 90 days before AS_OF
          },
          {
            user_address: 'GB',
            category: 'DEFI',
            resolved: '0',
            wins: '0',
            volume: '5',
            last_active: '2026-10-17T12:00:00.000Z',
          },
        ],
      ],
    });

    const result = await service.run(AS_OF);

    expect(result).toMatchObject({ usersProcessed: 2, skipped: false });

    const aggregate = calls.find((c) => c.sql.includes('CREATE TEMP TABLE'))!;
    expect(aggregate.params).toEqual([AS_OF]);
    expect(aggregate.sql).toContain('call_meta AS MATERIALIZED');
    const batchQuery = calls.find((c) =>
      c.sql.includes('WHERE user_address IN'),
    )!;
    expect(batchQuery.params).toEqual(['', 2000]);

    const upsert = calls.find((c) =>
      c.sql.includes('INSERT INTO user_reputation'),
    )!;
    expect(upsert.sql).toContain('ON CONFLICT ("userAddress") DO UPDATE');
    const [addr, base, decayed, factor, lastActive, json, top, computedAt] =
      upsert.params!.slice(0, 8);
    expect(addr).toBe('GA');
    expect(base).toBe(86);
    expect(decayed).toBe(43);
    expect(factor).toBe(0.5);
    expect(lastActive).toEqual(new Date('2026-07-20T00:00:00.000Z'));
    expect(
      (JSON.parse(json as string) as Record<string, unknown>).DEFI,
    ).toMatchObject({
      score: 43,
      tier: 'SKILLED',
      volume: '10000',
    });
    expect(top).toBe('DEFI');
    expect(computedAt).toBe(AS_OF);
    // Second user tuple follows; 8 params per user.
    expect(upsert.params).toHaveLength(16);
    expect(upsert.params![8]).toBe('GB');

    // Temp table dropped and lock released.
    expect(calls[calls.length - 2].sql).toContain('DROP TABLE IF EXISTS');
    expect(calls[calls.length - 1].sql).toContain('pg_advisory_unlock');
  });

  it('pages through users with a keyset cursor', async () => {
    const full = Array.from({ length: 2000 }, (_, i) => ({
      user_address: `G${String(i).padStart(5, '0')}`,
      category: 'OTHER',
      resolved: 1,
      wins: 1,
      volume: '1',
      last_active: AS_OF.toISOString(),
    }));
    const { service, calls } = makeRunner({ batches: [full, []] });

    const result = await service.run(AS_OF);

    expect(result.usersProcessed).toBe(2000);
    const pages = calls.filter((c) => c.sql.includes('WHERE user_address IN'));
    expect(pages).toHaveLength(2);
    expect(pages[1].params![0]).toBe('G01999');
  });

  it('releases the lock and connection when a batch fails', async () => {
    const { service, runner, calls } = makeRunner({});
    runner.query.mockImplementation((sql: string) => {
      calls.push({ sql });
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve([{ locked: true }]);
      }
      if (sql.includes('GROUP BY category')) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve([]);
    });

    await expect(service.run(AS_OF)).rejects.toThrow('boom');
    expect(calls.some((c) => c.sql.includes('pg_advisory_unlock'))).toBe(true);
    expect(
      calls.some((c) =>
        c.sql.includes('DROP TABLE IF EXISTS tmp_reputation_agg'),
      ),
    ).toBe(true);
    expect(runner.release).toHaveBeenCalled();
  });
});

describe('ReputationController (BE-032)', () => {
  it('returns indexed expertise and 404s otherwise', async () => {
    const service = {
      getCategoryExpertise: jest
        .fn()
        .mockResolvedValueOnce({ userAddress: 'GA', topCategory: 'DEFI' })
        .mockResolvedValueOnce(null),
    };
    const controller = new ReputationController(
      service as unknown as ReputationDecayService,
    );
    await expect(controller.getCategoryExpertise('GA')).resolves.toMatchObject({
      topCategory: 'DEFI',
    });
    await expect(controller.getCategoryExpertise('GZ')).rejects.toThrow(
      'No reputation indexed for GZ',
    );
  });
});
