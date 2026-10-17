import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

const SECOND_DEGREE_TTL_MS = 60_000;
const MAX_LIMIT = 100;

export interface AffinityStats {
  coBackCount: number;
  counterBackCount: number;
  sharedCalls: number;
  /** Share of shared calls where both backed the same side, 0–100. */
  agreementPct: number;
  /** Wilson lower bound of agreement, 0–100; ranks small samples conservatively. */
  affinityScore: number;
}

interface InteractionRow {
  counterpartAddress: string;
  coBackCount: number | string;
  counterBackCount: number | string;
  lastInteractionAt: Date;
}

/**
 * TypeORM's postgres driver returns `[rows, rowCount]` for UPDATE/DELETE and
 * plain `rows` for everything else; normalise to the affected row count.
 */
export function affectedRowCount(result: unknown): number {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[1];
  }
  return Array.isArray(result) ? result.length : 0;
}

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Wilson score interval lower bound (z = 1.96, 95% confidence). */
export function wilsonLowerBound(
  successes: number,
  total: number,
  z = 1.96,
): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / (1 + z2 / total));
}

export function computeAffinity(
  coBackCount: number,
  counterBackCount: number,
): AffinityStats {
  const co = Math.max(0, coBackCount);
  const counter = Math.max(0, counterBackCount);
  const shared = co + counter;
  return {
    coBackCount: co,
    counterBackCount: counter,
    sharedCalls: shared,
    agreementPct: shared ? round2((co / shared) * 100) : 0,
    affinityScore: round2(wilsonLowerBound(co, shared) * 100),
  };
}

export const clampLimit = (limit: number, fallback = 20) =>
  Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), MAX_LIMIT)
    : fallback;

/**
 * BE-034 — social graph indexing: co-backer / counter-backer interaction
 * edges, mutual affinity, second-degree discovery and follow-count repair.
 */
@Injectable()
export class SocialGraphService {
  private readonly logger = new Logger(SocialGraphService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  @OnEvent('stake.created', { async: true })
  async handleStakeCreated(payload: { userAddress: string; callId: string }) {
    try {
      await this.indexStake(payload.userAddress, payload.callId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to index social interaction for ${payload.userAddress} on ${payload.callId}: ${msg}`,
      );
    }
  }

  /**
   * Records `userAddress`'s first position on `callId` and bumps the
   * co-back / counter-back edge with every earlier participant.
   *
   * Exactly-once: a per-call advisory lock serialises participants, and the
   * social_call_positions primary key turns repeat events into no-ops.
   * Returns the number of counterparts linked.
   */
  async indexStake(userAddress: string, callId: string): Promise<number> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `social-call:${callId}`,
      ]);

      const inserted = await em.query<{ position: string }[]>(
        `
        INSERT INTO social_call_positions ("callId", "userAddress", position, "indexedAt")
        SELECT s."callId"::text, s."userAddress", s.position::text, NOW()
        FROM stakes s
        WHERE s."userAddress" = $1 AND s."callId"::text = $2
        ORDER BY s."createdAt" ASC, s.id ASC
        LIMIT 1
        ON CONFLICT ("callId", "userAddress") DO NOTHING
        RETURNING position
        `,
        [userAddress, callId],
      );
      if (!inserted.length) return 0;

      const linked = await em.query<unknown[]>(
        `
        WITH pairs AS (
          SELECT p."userAddress" AS other,
                 (p.position = $3)::int AS co,
                 (p.position <> $3)::int AS counter
          FROM social_call_positions p
          WHERE p."callId" = $2 AND p."userAddress" <> $1
        ), edges AS (
          SELECT $1::varchar AS a, other AS b, co, counter FROM pairs
          UNION ALL
          SELECT other AS a, $1::varchar AS b, co, counter FROM pairs
        )
        INSERT INTO user_interactions AS ui
          ("userAddress", "counterpartAddress", "coBackCount", "counterBackCount", "lastInteractionAt")
        SELECT a, b, co, counter, NOW() FROM edges
        ON CONFLICT ("userAddress", "counterpartAddress") DO UPDATE SET
          "coBackCount" = ui."coBackCount" + EXCLUDED."coBackCount",
          "counterBackCount" = ui."counterBackCount" + EXCLUDED."counterBackCount",
          "lastInteractionAt" = EXCLUDED."lastInteractionAt"
        RETURNING 1
        `,
        [userAddress, callId, inserted[0].position],
      );
      return linked.length / 2;
    });
  }

  async getAffinity(userAddress: string, otherAddress: string) {
    const [row] = await this.dataSource.query<
      Omit<InteractionRow, 'counterpartAddress'>[]
    >(
      `
      SELECT "coBackCount", "counterBackCount", "lastInteractionAt"
      FROM user_interactions
      WHERE "userAddress" = $1 AND "counterpartAddress" = $2
      `,
      [userAddress, otherAddress],
    );

    const [follow] = await this.dataSource.query<
      { following: boolean; followedBy: boolean }[]
    >(
      `
      SELECT
        EXISTS (SELECT 1 FROM follows WHERE "followerAddress" = $1 AND "followingAddress" = $2) AS following,
        EXISTS (SELECT 1 FROM follows WHERE "followerAddress" = $2 AND "followingAddress" = $1) AS "followedBy"
      `,
      [userAddress, otherAddress],
    );

    return {
      userAddress,
      otherAddress,
      ...computeAffinity(
        Number(row?.coBackCount ?? 0),
        Number(row?.counterBackCount ?? 0),
      ),
      lastInteractionAt: row?.lastInteractionAt ?? null,
      following: !!follow?.following,
      followedBy: !!follow?.followedBy,
      mutualFollow: !!follow?.following && !!follow?.followedBy,
    };
  }

  /** Users most often on the same side as `userAddress`. */
  getTopCoBackers(userAddress: string, limit = 20) {
    return this.rankInteractions(userAddress, 'coBackCount', limit);
  }

  /** Users most often on the opposite side — the rival leaderboard. */
  getTopRivals(userAddress: string, limit = 20) {
    return this.rankInteractions(userAddress, 'counterBackCount', limit);
  }

  private async rankInteractions(
    userAddress: string,
    column: 'coBackCount' | 'counterBackCount',
    limit: number,
  ) {
    const rows = await this.dataSource.query<InteractionRow[]>(
      `
      SELECT "counterpartAddress", "coBackCount", "counterBackCount", "lastInteractionAt"
      FROM user_interactions
      WHERE "userAddress" = $1 AND "${column}" > 0
      ORDER BY "${column}" DESC, "counterpartAddress" ASC
      LIMIT $2
      `,
      [userAddress, clampLimit(limit)],
    );

    return {
      userAddress,
      data: rows.map((r, i) => ({
        rank: i + 1,
        address: r.counterpartAddress,
        ...computeAffinity(Number(r.coBackCount), Number(r.counterBackCount)),
        lastInteractionAt: r.lastInteractionAt,
      })),
    };
  }

  /**
   * Second-degree connections: accounts followed by people `userAddress`
   * follows, excluding self and existing follows, ranked by mutual paths.
   * Served from two index lookups on follows plus a 60s cache.
   */
  async getSecondDegreeConnections(userAddress: string, limit = 20) {
    const take = clampLimit(limit);
    const key = this.secondDegreeKey(userAddress, take);
    const cached = await this.cacheManager.get(key);
    if (cached) return cached;

    const rows = await this.dataSource.query<
      { address: string; mutualConnections: number; via: string[] }[]
    >(
      `
      SELECT f2."followingAddress" AS address,
             COUNT(*)::int AS "mutualConnections",
             (ARRAY_AGG(f1."followingAddress" ORDER BY f1."followingAddress"))[1:3] AS via
      FROM follows f1
      JOIN follows f2 ON f2."followerAddress" = f1."followingAddress"
      WHERE f1."followerAddress" = $1
        AND f2."followingAddress" <> $1
        AND NOT EXISTS (
          SELECT 1 FROM follows f3
          WHERE f3."followerAddress" = $1 AND f3."followingAddress" = f2."followingAddress"
        )
      GROUP BY f2."followingAddress"
      ORDER BY "mutualConnections" DESC, address ASC
      LIMIT $2
      `,
      [userAddress, take],
    );

    const result = { userAddress, data: rows };
    await this.cacheManager.set(key, result, SECOND_DEGREE_TTL_MS);
    return result;
  }

  async invalidateSecondDegree(userAddress: string): Promise<void> {
    // Only the common page sizes are cached under predictable keys.
    await Promise.all(
      [10, 20, 50, MAX_LIMIT].map((n) =>
        this.cacheManager.del(this.secondDegreeKey(userAddress, n)),
      ),
    );
  }

  private secondDegreeKey(userAddress: string, limit: number) {
    return `social:2nd:${userAddress}:${limit}`;
  }

  /** Repairs drifted follower/following counters. Returns rows corrected. */
  @Cron('0 15 3 * * *', { name: 'follow-count-reconcile', timeZone: 'UTC' })
  async reconcileFollowCounts(): Promise<number> {
    const result = await this.dataSource.query<unknown>(`
      WITH actual AS (
        SELECT u."walletAddress",
               (SELECT COUNT(*) FROM follows f WHERE f."followingAddress" = u."walletAddress")::int AS followers,
               (SELECT COUNT(*) FROM follows f WHERE f."followerAddress" = u."walletAddress")::int AS following
        FROM users u
      )
      UPDATE users u SET "followerCount" = a.followers, "followingCount" = a.following
      FROM actual a
      WHERE a."walletAddress" = u."walletAddress"
        AND (u."followerCount" <> a.followers OR u."followingCount" <> a.following)
    `);
    const corrected = affectedRowCount(result);
    if (corrected) {
      this.logger.warn(`Reconciled follow counters for ${corrected} users`);
    }
    return corrected;
  }
}
