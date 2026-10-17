import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource, QueryRunner } from 'typeorm';
import { ExpertiseCategory } from './entities/user-reputation.entity';
import {
  categorySqlExpression,
  computeUserReputation,
  DAY_MS,
  normalizeCategory,
  startOfUtcDay,
  UserCategoryRow,
} from './reputation-math';

/** pg advisory lock key so only one replica runs the nightly job. */
const REPUTATION_DECAY_LOCK_KEY = 3_200_032;
const USER_BATCH_SIZE = 2_000;
const AGG_TABLE = 'tmp_reputation_agg';

interface CategoryAggregateRow {
  user_address: string;
  category: string;
  resolved: number | string;
  wins: number | string;
  volume: string;
  last_active: Date | string | null;
}

interface MaxVolumeRow {
  category: string | null;
  max_volume: string | null;
}

export interface ReputationDecayRunResult {
  asOf: string;
  usersProcessed: number;
  durationMs: number;
  skipped: boolean;
}

/**
 * BE-032 — nightly category expertise indexing + 90-day half-life decay.
 *
 * Runs at 23:50 UTC with `asOf` pinned to the upcoming UTC midnight so the
 * 00:00 UTC daily snapshot (BE-036) freezes scores computed for the same
 * cutoff. All aggregation is set-based in Postgres; per-user math is pure
 * (see reputation-math.ts) and results are upserted in batches.
 */
@Injectable()
export class ReputationDecayService {
  private readonly logger = new Logger(ReputationDecayService.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron('0 50 23 * * *', { name: 'reputation-decay', timeZone: 'UTC' })
  async handleNightlyRun(): Promise<void> {
    const asOf = new Date(startOfUtcDay(new Date()).getTime() + DAY_MS);
    try {
      const result = await this.run(asOf);
      if (!result.skipped) {
        this.logger.log(
          `Reputation decay as of ${result.asOf}: ${result.usersProcessed} users in ${result.durationMs}ms`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Reputation decay run failed: ${msg}`);
    }
  }

  /**
   * Recomputes every predictor's reputation as of `asOf`. Deterministic for a
   * given dataset and `asOf`, and safe to rerun (rows are upserted).
   */
  async run(asOf: Date): Promise<ReputationDecayRunResult> {
    const started = Date.now();
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = (await runner.query(
        `SELECT pg_try_advisory_lock($1) AS locked`,
        [REPUTATION_DECAY_LOCK_KEY],
      )) as { locked: boolean }[];
      if (!locked) {
        this.logger.warn(
          'Reputation decay already running elsewhere; skipping',
        );
        return {
          asOf: asOf.toISOString(),
          usersProcessed: 0,
          durationMs: 0,
          skipped: true,
        };
      }

      try {
        await this.materializeAggregates(runner, asOf);
        const { byCategory, overall } = await this.loadMaxVolumes(runner);
        let usersProcessed = 0;
        let cursor = '';

        for (;;) {
          const rows = (await runner.query(
            `SELECT user_address, category, resolved, wins, volume::text AS volume, last_active
             FROM ${AGG_TABLE}
             WHERE user_address IN (
               SELECT DISTINCT user_address FROM ${AGG_TABLE}
               WHERE user_address > $1 ORDER BY user_address LIMIT $2
             )
             ORDER BY user_address, category`,
            [cursor, USER_BATCH_SIZE],
          )) as CategoryAggregateRow[];
          if (!rows.length) break;

          const grouped = this.groupByUser(rows);
          await this.upsertBatch(runner, grouped, byCategory, overall, asOf);

          usersProcessed += grouped.size;
          cursor = rows[rows.length - 1].user_address;
          if (grouped.size < USER_BATCH_SIZE) break;
        }

        return {
          asOf: asOf.toISOString(),
          usersProcessed,
          durationMs: Date.now() - started,
          skipped: false,
        };
      } finally {
        await runner.query(`DROP TABLE IF EXISTS ${AGG_TABLE}`);
        await runner.query(`SELECT pg_advisory_unlock($1)`, [
          REPUTATION_DECAY_LOCK_KEY,
        ]);
      }
    } finally {
      await runner.release();
    }
  }

  /**
   * One set-based pass over stakes into a session temp table of
   * (user, category) aggregates. Calls are classified once each, not once
   * per stake, which keeps the regex cost proportional to the call count.
   */
  private async materializeAggregates(runner: QueryRunner, asOf: Date) {
    await runner.query(`DROP TABLE IF EXISTS ${AGG_TABLE}`);
    await runner.query(
      `
      CREATE TEMP TABLE ${AGG_TABLE} AS
      WITH call_meta AS MATERIALIZED (
        SELECT c.id,
               ${categorySqlExpression('c')} AS category,
               (c.outcome IN ('YES', 'NO') AND c."resolvedAt" < $1) AS resolved,
               c.outcome::text AS outcome
        FROM calls c
      )
      SELECT s."userAddress" AS user_address,
             cm.category,
             COUNT(*) FILTER (WHERE cm.resolved)::int AS resolved,
             COUNT(*) FILTER (
               WHERE cm.resolved AND s.position::text = cm.outcome
             )::int AS wins,
             COALESCE(SUM(s.amount), 0) AS volume,
             MAX(s."createdAt") AS last_active
      FROM stakes s
      JOIN call_meta cm ON cm.id = s."callId"
      WHERE s."createdAt" < $1
      GROUP BY 1, 2
      `,
      [asOf],
    );
    await runner.query(`CREATE INDEX ON ${AGG_TABLE} (user_address)`);
    await runner.query(`ANALYZE ${AGG_TABLE}`);
  }

  private async loadMaxVolumes(
    runner: QueryRunner,
  ): Promise<{ byCategory: Map<ExpertiseCategory, number>; overall: number }> {
    // One row per category plus a NULL-category row for the overall max.
    const rows = (await runner.query(`
      SELECT category, MAX(volume)::text AS max_volume FROM ${AGG_TABLE} GROUP BY category
      UNION ALL
      SELECT NULL, MAX(total)::text FROM (
        SELECT SUM(volume) AS total FROM ${AGG_TABLE} GROUP BY user_address
      ) t
    `)) as MaxVolumeRow[];

    const byCategory = new Map<ExpertiseCategory, number>();
    let overall = 0;
    for (const row of rows) {
      const max = Number(row.max_volume ?? 0);
      const category = normalizeCategory(row.category);
      if (category) byCategory.set(category, max);
      else if (row.category === null) overall = max;
    }
    return { byCategory, overall };
  }

  private groupByUser(
    rows: CategoryAggregateRow[],
  ): Map<string, UserCategoryRow[]> {
    const grouped = new Map<string, UserCategoryRow[]>();
    for (const row of rows) {
      const list = grouped.get(row.user_address) ?? [];
      list.push({
        category: normalizeCategory(row.category) ?? ExpertiseCategory.OTHER,
        resolvedCalls: Number(row.resolved),
        wins: Number(row.wins),
        volume: row.volume ?? '0',
        lastActiveAt: row.last_active ? new Date(row.last_active) : null,
      });
      grouped.set(row.user_address, list);
    }
    return grouped;
  }

  private async upsertBatch(
    runner: QueryRunner,
    grouped: Map<string, UserCategoryRow[]>,
    maxByCategory: Map<ExpertiseCategory, number>,
    maxOverall: number,
    asOf: Date,
  ): Promise<void> {
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const [userAddress, rows] of grouped) {
      const rep = computeUserReputation(rows, maxByCategory, maxOverall, asOf);
      const o = params.length;
      tuples.push(
        `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}::jsonb, $${o + 7}, $${o + 8})`,
      );
      params.push(
        userAddress,
        rep.basePoints,
        rep.decayedPoints,
        rep.decayFactor,
        rep.lastActiveAt,
        JSON.stringify(rep.categoryScores),
        rep.topCategory,
        asOf,
      );
    }
    if (!tuples.length) return;

    await runner.query(
      `
      INSERT INTO user_reputation
        ("userAddress", "basePoints", "decayedPoints", "decayFactor",
         "lastActiveAt", "categoryScores", "topCategory", "computedAt")
      VALUES ${tuples.join(', ')}
      ON CONFLICT ("userAddress") DO UPDATE SET
        "basePoints" = EXCLUDED."basePoints",
        "decayedPoints" = EXCLUDED."decayedPoints",
        "decayFactor" = EXCLUDED."decayFactor",
        "lastActiveAt" = EXCLUDED."lastActiveAt",
        "categoryScores" = EXCLUDED."categoryScores",
        "topCategory" = EXCLUDED."topCategory",
        "computedAt" = EXCLUDED."computedAt"
      `,
      params,
    );
  }

  // ─── Category expertise (BE-032) ─────────────────────────────────────────

  /** Latest nightly reputation + category breakdown, or null if never indexed. */
  async getCategoryExpertise(userAddress: string) {
    const [row] = await this.dataSource.query<Record<string, unknown>[]>(
      `
      SELECT "userAddress", "basePoints"::text AS "basePoints",
             "decayedPoints"::text AS "decayedPoints", "decayFactor"::text AS "decayFactor",
             "lastActiveAt", "categoryScores", "topCategory", "computedAt"
      FROM user_reputation WHERE "userAddress" = $1
      `,
      [userAddress],
    );
    return row ?? null;
  }
}
