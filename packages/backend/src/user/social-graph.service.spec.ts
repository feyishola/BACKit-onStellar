import { DataSource } from 'typeorm';
import { Cache } from 'cache-manager';
import {
  affectedRowCount,
  clampLimit,
  computeAffinity,
  SocialGraphService,
  wilsonLowerBound,
} from './social-graph.service';

describe('social graph math (BE-034)', () => {
  it('computes agreement percentage from co-back vs counter-back counts', () => {
    expect(computeAffinity(3, 1)).toMatchObject({
      sharedCalls: 4,
      agreementPct: 75,
    });
    expect(computeAffinity(0, 0)).toMatchObject({
      sharedCalls: 0,
      agreementPct: 0,
      affinityScore: 0,
    });
    expect(computeAffinity(1, 2).agreementPct).toBe(33.33);
  });

  it('ranks larger samples above lucky small ones via the Wilson bound', () => {
    const lucky = computeAffinity(1, 0); // 100% from one call
    const proven = computeAffinity(45, 5); // 90% from fifty calls
    expect(lucky.agreementPct).toBeGreaterThan(proven.agreementPct);
    expect(proven.affinityScore).toBeGreaterThan(lucky.affinityScore);
  });

  it('wilson bound stays within [0, p] and tightens with n', () => {
    for (const n of [1, 5, 20, 100, 1000]) {
      const lb = wilsonLowerBound(n * 0.7, n);
      expect(lb).toBeGreaterThanOrEqual(0);
      expect(lb).toBeLessThanOrEqual(0.7);
    }
    expect(wilsonLowerBound(700, 1000)).toBeGreaterThan(
      wilsonLowerBound(7, 10),
    );
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('clamps limits', () => {
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(10_000)).toBe(100);
    expect(clampLimit(0)).toBe(20);
    expect(clampLimit(Number.NaN)).toBe(20);
  });

  it('normalises TypeORM UPDATE/DELETE results', () => {
    expect(affectedRowCount([[{ id: 1 }], 1])).toBe(1);
    expect(affectedRowCount([[], 0])).toBe(0);
    expect(affectedRowCount([{ id: 1 }, { id: 2 }, { id: 3 }])).toBe(3);
    expect(affectedRowCount(undefined)).toBe(0);
  });
});

describe('SocialGraphService (BE-034)', () => {
  const cache = new Map<string, unknown>();
  const cacheManager = {
    get: jest.fn((k: string) => Promise.resolve(cache.get(k))),
    set: jest.fn((k: string, v: unknown) => {
      cache.set(k, v);
      return Promise.resolve();
    }),
    del: jest.fn((k: string) => {
      cache.delete(k);
      return Promise.resolve();
    }),
  };
  type QueryCall = [string, unknown[]?];
  let em: { query: jest.Mock<Promise<unknown>, QueryCall> };
  let dataSource: {
    query: jest.Mock<Promise<unknown>, QueryCall>;
    transaction: jest.Mock;
  };
  let service: SocialGraphService;

  beforeEach(() => {
    cache.clear();
    jest.clearAllMocks();
    em = { query: jest.fn<Promise<unknown>, QueryCall>() };
    dataSource = {
      query: jest.fn<Promise<unknown>, QueryCall>(),
      transaction: jest.fn((cb: (e: typeof em) => unknown) =>
        Promise.resolve(cb(em)),
      ),
    };
    service = new SocialGraphService(
      dataSource as unknown as DataSource,
      cacheManager as unknown as Cache,
    );
  });

  describe('indexStake', () => {
    it('links the new participant to every earlier one, both directions', async () => {
      em.query
        .mockResolvedValueOnce(undefined) // advisory lock
        .mockResolvedValueOnce([{ position: 'YES' }]) // ledger insert
        .mockResolvedValueOnce([1, 1, 1, 1]); // 2 counterparts × 2 directions

      await expect(service.indexStake('GA', 'call-1')).resolves.toBe(2);

      expect(em.query.mock.calls[0][1]).toEqual(['social-call:call-1']);
      const [edgeSql, edgeParams] = em.query.mock.calls[2];
      expect(edgeSql).toContain('UNION ALL');
      expect(edgeSql).toContain(
        '"coBackCount" = ui."coBackCount" + EXCLUDED."coBackCount"',
      );
      expect(edgeParams).toEqual(['GA', 'call-1', 'YES']);
    });

    it('is a no-op when the (call, user) pair was already indexed', async () => {
      em.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce([]);

      await expect(service.indexStake('GA', 'call-1')).resolves.toBe(0);
      expect(em.query).toHaveBeenCalledTimes(2);
    });

    it('swallows indexing errors from the event handler', async () => {
      dataSource.transaction.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.handleStakeCreated({ userAddress: 'GA', callId: 'c' }),
      ).resolves.toBeUndefined();
    });
  });

  it('builds the rival leaderboard ordered by counter-backs', async () => {
    dataSource.query.mockResolvedValueOnce([
      {
        counterpartAddress: 'GB',
        coBackCount: '1',
        counterBackCount: '9',
        lastInteractionAt: new Date(0),
      },
      {
        counterpartAddress: 'GC',
        coBackCount: 2,
        counterBackCount: 4,
        lastInteractionAt: new Date(0),
      },
    ]);

    const result = await service.getTopRivals('GA', 500);

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('ORDER BY "counterBackCount" DESC');
    expect(params).toEqual(['GA', 100]);
    expect(result.data[0]).toMatchObject({
      rank: 1,
      address: 'GB',
      agreementPct: 10,
    });
    expect(result.data[1]).toMatchObject({
      rank: 2,
      address: 'GC',
      agreementPct: 33.33,
    });
  });

  it('reports mutual affinity and follow relationship', async () => {
    dataSource.query
      .mockResolvedValueOnce([
        { coBackCount: 8, counterBackCount: 2, lastInteractionAt: null },
      ])
      .mockResolvedValueOnce([{ following: true, followedBy: true }]);

    const result = await service.getAffinity('GA', 'GB');

    expect(result).toMatchObject({
      agreementPct: 80,
      sharedCalls: 10,
      mutualFollow: true,
    });
  });

  describe('second-degree connections', () => {
    it('queries once then serves from cache until invalidated', async () => {
      dataSource.query.mockResolvedValue([
        { address: 'GZ', mutualConnections: 3, via: ['GB', 'GC', 'GD'] },
      ]);

      const first = await service.getSecondDegreeConnections('GA', 20);
      const second = await service.getSecondDegreeConnections('GA', 20);
      expect(second).toBe(first);
      expect(dataSource.query).toHaveBeenCalledTimes(1);

      const sql = dataSource.query.mock.calls[0][0];
      expect(sql).toContain(
        'JOIN follows f2 ON f2."followerAddress" = f1."followingAddress"',
      );
      expect(sql).toContain('NOT EXISTS');

      await service.invalidateSecondDegree('GA');
      await service.getSecondDegreeConnections('GA', 20);
      expect(dataSource.query).toHaveBeenCalledTimes(2);
    });
  });

  it('reconciles drifted follow counters', async () => {
    dataSource.query.mockResolvedValueOnce([[{ walletAddress: 'GA' }], 1]);
    await expect(service.reconcileFollowCounts()).resolves.toBe(1);
  });
});
