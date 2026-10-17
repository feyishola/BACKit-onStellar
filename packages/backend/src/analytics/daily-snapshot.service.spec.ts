import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import {
  DAILY_SNAPSHOT_CRON,
  DAILY_SNAPSHOT_JOB,
  DAILY_SNAPSHOT_SCHEDULER_ID,
  DailySnapshotService,
  parseSnapshotDate,
  snapshotDateForFireTime,
} from './daily-snapshot.service';
import { SnapshotsController } from './snapshots.controller';
import {
  DailySnapshotJobData,
  DailySnapshotProcessor,
  resolveSnapshotDate,
} from './daily-snapshot.processor';

function makeRunner(responses: Record<string, unknown>) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const runner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    query: jest.fn((sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      for (const [needle, value] of Object.entries(responses)) {
        if (sql.includes(needle)) {
          return value instanceof Error
            ? Promise.reject(value)
            : Promise.resolve(value);
        }
      }
      return Promise.resolve([]);
    }),
  };
  return { runner, calls };
}

function makeService(runner: ReturnType<typeof makeRunner>['runner']) {
  const dataSource = {
    createQueryRunner: jest.fn(() => runner),
  } as unknown as DataSource;
  return new DailySnapshotService(dataSource);
}

describe('DailySnapshotService (BE-036)', () => {
  describe('date helpers', () => {
    it('snapshots the UTC day that just ended at midnight', () => {
      expect(
        snapshotDateForFireTime(new Date('2026-10-18T00:00:00.000Z')),
      ).toBe('2026-10-17');
      // Late or slightly early workers still pick the right day.
      expect(
        snapshotDateForFireTime(new Date('2026-10-18T03:12:00.000Z')),
      ).toBe('2026-10-17');
      expect(
        snapshotDateForFireTime(new Date('2026-03-01T00:00:00.000Z')),
      ).toBe('2026-02-28');
      expect(
        snapshotDateForFireTime(new Date('2027-01-01T00:00:00.000Z')),
      ).toBe('2026-12-31');
    });

    it('rejects malformed or impossible dates', () => {
      expect(() => parseSnapshotDate('2026-02-30')).toThrow();
      expect(() => parseSnapshotDate('17-10-2026')).toThrow();
      expect(() => parseSnapshotDate("2026-10-17'; DROP")).toThrow();
      expect(parseSnapshotDate('2026-10-17').toISOString()).toBe(
        '2026-10-17T00:00:00.000Z',
      );
    });
  });

  describe('generate', () => {
    it('writes user rows, then the protocol marker, in one transaction', async () => {
      const { runner, calls } = makeRunner({
        'COUNT(*)::int AS user_count': [
          {
            user_count: 3,
            protocol_tvl: '1500.5000000',
            daily_volume: '200',
            daily_active_users: 2,
          },
        ],
        'AS token': [
          { token: 'NATIVE', tvl: '1000.5' },
          { token: 'USDC', tvl: '500' },
        ],
        'AS active_calls': [
          { active_calls: 4, calls_created: 2, calls_resolved: 1 },
        ],
        'AS stakes_placed': [{ stakes_placed: 7 }],
        'AS total_users': [{ total_users: 10 }],
        '"leaderboardRank" AS rank': [
          {
            rank: '1',
            userAddress: 'GA',
            realizedProfit: '50',
            reputation: '80',
          },
        ],
      });
      const service = makeService(runner);

      const result = await service.generate('2026-01-15');

      expect(result).toMatchObject({
        snapshotDate: '2026-01-15',
        created: true,
        userSnapshotCount: 3,
      });
      expect(runner.startTransaction).toHaveBeenCalled();
      expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(runner.rollbackTransaction).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalled();

      // Per-date advisory lock is the very first statement.
      expect(calls[0].sql).toContain('pg_advisory_xact_lock');
      expect(calls[0].params).toEqual(['daily-snapshot:2026-01-15']);

      const userInsert = calls.find((c) =>
        c.sql.includes('INSERT INTO daily_user_snapshots'),
      );
      expect(userInsert!.sql).toContain('DO NOTHING');
      expect(userInsert!.params).toEqual([
        new Date('2026-01-15T00:00:00.000Z'),
        new Date('2026-01-16T00:00:00.000Z'),
        '2026-01-15',
      ]);

      const protocolInsertIdx = calls.findIndex((c) =>
        c.sql.includes('INSERT INTO daily_protocol_snapshots'),
      );
      expect(protocolInsertIdx).toBeGreaterThan(calls.indexOf(userInsert!));
      const params = calls[protocolInsertIdx].params!;
      expect(params.slice(0, 11)).toEqual([
        '2026-01-15',
        '1500.5000000',
        JSON.stringify({ NATIVE: '1000.5', USDC: '500' }),
        4,
        2,
        1,
        7,
        '200',
        2,
        10,
        JSON.stringify([
          {
            rank: 1,
            userAddress: 'GA',
            realizedProfit: '50',
            reputation: '80',
          },
        ]),
      ]);
      expect(params[11]).toBe(3);
    });

    it('joins BE-032 reputation only when user_reputation exists', async () => {
      const without = makeRunner({});
      await makeService(without.runner).generate('2026-01-15');
      const insertWithout = without.calls.find((c) =>
        c.sql.includes('INSERT INTO daily_user_snapshots'),
      )!;
      expect(insertWithout.sql).not.toContain('user_reputation');

      const withRep = makeRunner({ to_regclass: [{ present: true }] });
      await makeService(withRep.runner).generate('2026-01-15');
      const insertWith = withRep.calls.find((c) =>
        c.sql.includes('INSERT INTO daily_user_snapshots'),
      )!;
      expect(insertWith.sql).toContain('LEFT JOIN user_reputation r');
      expect(insertWith.sql).toContain('COALESCE(r."decayedPoints", 0)');
    });

    it('is idempotent: an existing protocol row short-circuits without writes', async () => {
      const { runner, calls } = makeRunner({
        'FROM daily_protocol_snapshots WHERE': [{ userSnapshotCount: 42 }],
      });
      const service = makeService(runner);

      const result = await service.generate('2026-01-15');

      expect(result).toMatchObject({ created: false, userSnapshotCount: 42 });
      expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
      expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('rolls back everything if any step fails', async () => {
      const { runner } = makeRunner({
        'INSERT INTO daily_protocol_snapshots': new Error('disk full'),
      });
      const service = makeService(runner);

      await expect(service.generate('2026-01-15')).rejects.toThrow('disk full');
      expect(runner.rollbackTransaction).toHaveBeenCalled();
      expect(runner.commitTransaction).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalled();
    });

    it('refuses to snapshot a day that has not ended', async () => {
      const { runner } = makeRunner({});
      const service = makeService(runner);
      const today = new Date().toISOString().slice(0, 10);

      await expect(service.generate(today)).rejects.toThrow(
        /before it has ended/,
      );
      expect(runner.connect).not.toHaveBeenCalled();
    });
  });
});

describe('DailySnapshotProcessor (BE-036)', () => {
  const job = (data: DailySnapshotJobData, timestamp: number, delay?: number) =>
    ({
      data,
      timestamp,
      opts: { delay },
    }) as unknown as Job<DailySnapshotJobData>;

  it('derives the date from the scheduled fire time, not worker lag', () => {
    // Enqueued at 00:00:00.010 on the 17th, delayed until 00:00:00 on the 18th.
    const enqueuedAt = Date.parse('2026-10-17T00:00:00.010Z');
    const delay = Date.parse('2026-10-18T00:00:00.000Z') - enqueuedAt;
    expect(resolveSnapshotDate(job({}, enqueuedAt, delay))).toBe('2026-10-17');
  });

  it('honours an explicit backfill date', () => {
    expect(
      resolveSnapshotDate(job({ snapshotDate: '2026-01-05' }, Date.now())),
    ).toBe('2026-01-05');
  });

  it('registers a midnight-UTC scheduler and a deduplicated catch-up job', async () => {
    const queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = { generate: jest.fn() };
    const processor = new DailySnapshotProcessor(
      service as unknown as DailySnapshotService,
      queue as never,
    );

    await processor.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      DAILY_SNAPSHOT_SCHEDULER_ID,
      { pattern: DAILY_SNAPSHOT_CRON, tz: 'UTC' },
      { name: DAILY_SNAPSHOT_JOB, data: {} },
    );
    const yesterday = snapshotDateForFireTime(new Date());
    expect(queue.add).toHaveBeenCalledWith(
      DAILY_SNAPSHOT_JOB,
      { snapshotDate: yesterday },
      { jobId: `${DAILY_SNAPSHOT_JOB}-${yesterday}` },
    );
  });

  it('delegates processing to the service', async () => {
    const service = {
      generate: jest.fn().mockResolvedValue({ created: true }),
    };
    const processor = new DailySnapshotProcessor(
      service as unknown as DailySnapshotService,
      {} as never,
    );
    await processor.process(job({ snapshotDate: '2026-10-17' }, Date.now()));
    expect(service.generate).toHaveBeenCalledWith('2026-10-17');
  });
});

describe('SnapshotsController (BE-036)', () => {
  const service = {
    getProtocolSnapshots: jest.fn(),
    getUserSnapshots: jest.fn(),
    getLeaderboardSnapshot: jest.fn(),
  };
  const controller = new SnapshotsController(
    service as unknown as DailySnapshotService,
  );

  it('delegates history queries', () => {
    controller.getProtocolSnapshots('2026-01-01', '2026-01-31');
    controller.getUserSnapshots('GA', '2026-01-01');
    controller.getLeaderboardSnapshot('2026-01-15', 2, 25);
    expect(service.getProtocolSnapshots).toHaveBeenCalledWith(
      '2026-01-01',
      '2026-01-31',
    );
    expect(service.getUserSnapshots).toHaveBeenCalledWith(
      'GA',
      '2026-01-01',
      undefined,
    );
    expect(service.getLeaderboardSnapshot).toHaveBeenCalledWith(
      '2026-01-15',
      2,
      25,
    );
  });

  it('rejects malformed leaderboard dates', () => {
    expect(() =>
      controller.getLeaderboardSnapshot('15-01-2026', 1, 50),
    ).toThrow('date must be YYYY-MM-DD');
  });
});
