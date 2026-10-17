import { Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { DAY_MS, startOfUtcDay, toUtcDateString } from './utc-date';
import { LeaderboardStanding } from './entities/daily-snapshot.entity';

export const DAILY_SNAPSHOT_JOB = 'daily-snapshot';
export const DAILY_SNAPSHOT_SCHEDULER_ID = 'daily-snapshot-midnight-utc';
export const DAILY_SNAPSHOT_CRON = '0 0 0 * * *';
export const LEADERBOARD_TOP_N = 100;

export interface DailySnapshotResult {
  snapshotDate: string;
  created: boolean;
  userSnapshotCount: number;
  durationMs: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses and validates a YYYY-MM-DD UTC calendar date. */
export function parseSnapshotDate(date: string): Date {
  if (!DATE_RE.test(date)) {
    throw new Error(`Invalid snapshot date "${date}" (expected YYYY-MM-DD)`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || toUtcDateString(parsed) !== date) {
    throw new Error(`Invalid snapshot date "${date}"`);
  }
  return parsed;
}

/**
 * The UTC day a run fired at `fireAt` should freeze: the day that just ended.
 * A job scheduled for 2026-10-18T00:00:00Z snapshots 2026-10-17.
 */
export function snapshotDateForFireTime(fireAt: Date): string {
  return toUtcDateString(new Date(startOfUtcDay(fireAt).getTime() - DAY_MS));
}

/**
 * BE-036 — freezes end-of-day user reputation, TVL, call volume and
 * leaderboard standings into insert-only snapshot tables.
 *
 * Idempotency: everything for a date is written in one transaction guarded
 * by a per-date advisory lock; the protocol row is the completion marker and
 * user rows use ON CONFLICT DO NOTHING, so reruns are no-ops.
 */
@Injectable()
export class DailySnapshotService {
  private readonly logger = new Logger(DailySnapshotService.name);

  constructor(private readonly dataSource: DataSource) {}

  async generate(snapshotDate: string): Promise<DailySnapshotResult> {
    const dayStart = parseSnapshotDate(snapshotDate);
    const cutoff = new Date(dayStart.getTime() + DAY_MS);
    if (cutoff.getTime() > Date.now()) {
      throw new Error(
        `Cannot snapshot ${snapshotDate} before it has ended (cutoff ${cutoff.toISOString()})`,
      );
    }

    const started = Date.now();
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `daily-snapshot:${snapshotDate}`,
      ]);

      const existing = (await runner.query(
        `SELECT "userSnapshotCount" FROM daily_protocol_snapshots WHERE "snapshotDate" = $1`,
        [snapshotDate],
      )) as { userSnapshotCount: number }[];
      if (existing.length) {
        await runner.commitTransaction();
        this.logger.log(`Snapshot ${snapshotDate} already exists; skipping`);
        return {
          snapshotDate,
          created: false,
          userSnapshotCount: Number(existing[0].userSnapshotCount),
          durationMs: Date.now() - started,
        };
      }

      await this.insertUserSnapshots(runner, snapshotDate, dayStart, cutoff);
      const userSnapshotCount = await this.insertProtocolSnapshot(
        runner,
        snapshotDate,
        dayStart,
        cutoff,
        started,
      );

      await runner.commitTransaction();
      const durationMs = Date.now() - started;
      this.logger.log(
        `Snapshot ${snapshotDate} created: ${userSnapshotCount} users in ${durationMs}ms`,
      );
      return { snapshotDate, created: true, userSnapshotCount, durationMs };
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  /**
   * Reputation comes from the BE-032 nightly table when it is deployed;
   * without it, snapshots still freeze everything else with a zero score.
   */
  private async hasReputationTable(runner: QueryRunner): Promise<boolean> {
    const [row] = (await runner.query(
      `SELECT to_regclass('public.user_reputation') IS NOT NULL AS present`,
    )) as { present: boolean }[];
    return !!row?.present;
  }

  private async insertUserSnapshots(
    runner: QueryRunner,
    snapshotDate: string,
    dayStart: Date,
    cutoff: Date,
  ): Promise<void> {
    const withReputation = await this.hasReputationTable(runner);
    const reputation = withReputation
      ? `COALESCE(r."decayedPoints", 0)`
      : `0::numeric`;
    const categoryScores = withReputation
      ? `COALESCE(r."categoryScores", '{}'::jsonb)`
      : `'{}'::jsonb`;
    const reputationJoin = withReputation
      ? `LEFT JOIN user_reputation r ON r."userAddress" = u.user_address`
      : '';
    // "Active" = stake placed before the cutoff on a call not yet resolved at the cutoff.
    await runner.query(
      `
      WITH user_stats AS (
        SELECT
          s."userAddress" AS user_address,
          COALESCE(SUM(s.amount) FILTER (
            WHERE c."resolvedAt" IS NULL OR c."resolvedAt" >= $2
          ), 0) AS tvl,
          COUNT(*) FILTER (
            WHERE c."resolvedAt" IS NULL OR c."resolvedAt" >= $2
          )::int AS active_stakes,
          COALESCE(SUM(s.amount), 0) AS lifetime_volume,
          COALESCE(SUM(s.amount) FILTER (WHERE s."createdAt" >= $1), 0) AS daily_volume,
          COUNT(*) FILTER (
            WHERE c.outcome IN ('YES', 'NO') AND c."resolvedAt" < $2
              AND s.position::text = c.outcome::text
          )::int AS wins,
          COUNT(*) FILTER (
            WHERE c.outcome IN ('YES', 'NO') AND c."resolvedAt" < $2
              AND s.position::text <> c.outcome::text
          )::int AS losses,
          COALESCE(SUM(s."profitLoss") FILTER (WHERE c."resolvedAt" < $2), 0) AS realized_profit
        FROM stakes s
        JOIN calls c ON c.id = s."callId"
        WHERE s."createdAt" < $2
        GROUP BY s."userAddress"
      )
      INSERT INTO daily_user_snapshots
        ("snapshotDate", "userAddress", "reputationScore", "categoryScores",
         tvl, "activeStakeCount", "lifetimeVolume", "dailyVolume",
         wins, losses, "realizedProfit", "leaderboardRank")
      SELECT
        $3::date,
        u.user_address,
        ${reputation},
        ${categoryScores},
        u.tvl,
        u.active_stakes,
        u.lifetime_volume,
        u.daily_volume,
        u.wins,
        u.losses,
        u.realized_profit,
        ROW_NUMBER() OVER (
          ORDER BY u.realized_profit DESC,
                   ${reputation} DESC,
                   u.user_address ASC
        )
      FROM user_stats u
      ${reputationJoin}
      ON CONFLICT ON CONSTRAINT "UQ_daily_user_snapshot_date_user" DO NOTHING
      `,
      [dayStart, cutoff, snapshotDate],
    );
  }

  private async insertProtocolSnapshot(
    runner: QueryRunner,
    snapshotDate: string,
    dayStart: Date,
    cutoff: Date,
    started: number,
  ): Promise<number> {
    const [userAgg] = (await runner.query(
      `
      SELECT COUNT(*)::int AS user_count,
             COALESCE(SUM(tvl), 0)::text AS protocol_tvl,
             COALESCE(SUM("dailyVolume"), 0)::text AS daily_volume,
             COUNT(*) FILTER (WHERE "dailyVolume" > 0)::int AS daily_active_users
      FROM daily_user_snapshots
      WHERE "snapshotDate" = $1
      `,
      [snapshotDate],
    )) as {
      user_count: number;
      protocol_tvl: string;
      daily_volume: string;
      daily_active_users: number;
    }[];

    const tvlRows = (await runner.query(
      `
      SELECT COALESCE(c."stakeToken", 'NATIVE') AS token,
             COALESCE(SUM(s.amount), 0)::text AS tvl
      FROM stakes s
      JOIN calls c ON c.id = s."callId"
      WHERE s."createdAt" < $1
        AND (c."resolvedAt" IS NULL OR c."resolvedAt" >= $1)
      GROUP BY 1
      ORDER BY 1
      `,
      [cutoff],
    )) as { token: string; tvl: string }[];

    const [callAgg] = (await runner.query(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE c."createdAt" < $2 AND (c."resolvedAt" IS NULL OR c."resolvedAt" >= $2)
        )::int AS active_calls,
        COUNT(*) FILTER (WHERE c."createdAt" >= $1 AND c."createdAt" < $2)::int AS calls_created,
        COUNT(*) FILTER (WHERE c."resolvedAt" >= $1 AND c."resolvedAt" < $2)::int AS calls_resolved
      FROM calls c
      `,
      [dayStart, cutoff],
    )) as {
      active_calls: number;
      calls_created: number;
      calls_resolved: number;
    }[];

    const [stakeAgg] = (await runner.query(
      `SELECT COUNT(*)::int AS stakes_placed FROM stakes WHERE "createdAt" >= $1 AND "createdAt" < $2`,
      [dayStart, cutoff],
    )) as { stakes_placed: number }[];

    const [userCount] = (await runner.query(
      `SELECT COUNT(*)::int AS total_users FROM users WHERE "createdAt" < $1`,
      [cutoff],
    )) as { total_users: number }[];

    const leaderboardTop = (
      (await runner.query(
        `
        SELECT "leaderboardRank" AS rank, "userAddress", "realizedProfit"::text AS "realizedProfit",
               "reputationScore"::text AS reputation
        FROM daily_user_snapshots
        WHERE "snapshotDate" = $1
        ORDER BY "leaderboardRank" ASC
        LIMIT $2
        `,
        [snapshotDate, LEADERBOARD_TOP_N],
      )) as LeaderboardStanding[]
    ).map((r) => ({ ...r, rank: Number(r.rank) }));

    const tvlByToken = Object.fromEntries(tvlRows.map((r) => [r.token, r.tvl]));
    const userSnapshotCount = Number(userAgg?.user_count ?? 0);

    await runner.query(
      `
      INSERT INTO daily_protocol_snapshots
        ("snapshotDate", "protocolTvl", "tvlByToken", "activeCalls", "callsCreated",
         "callsResolved", "stakesPlaced", "dailyVolume", "dailyActiveUsers",
         "totalUsers", "leaderboardTop", "userSnapshotCount", "generationMs")
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
      ON CONFLICT ON CONSTRAINT "UQ_daily_protocol_snapshot_date" DO NOTHING
      `,
      [
        snapshotDate,
        userAgg?.protocol_tvl ?? '0',
        JSON.stringify(tvlByToken),
        Number(callAgg?.active_calls ?? 0),
        Number(callAgg?.calls_created ?? 0),
        Number(callAgg?.calls_resolved ?? 0),
        Number(stakeAgg?.stakes_placed ?? 0),
        userAgg?.daily_volume ?? '0',
        Number(userAgg?.daily_active_users ?? 0),
        Number(userCount?.total_users ?? 0),
        JSON.stringify(leaderboardTop),
        userSnapshotCount,
        Date.now() - started,
      ],
    );

    return userSnapshotCount;
  }

  // ─── Historical point-in-time queries ────────────────────────────────────

  /** Clamps a [from, to] YYYY-MM-DD range to at most `maxDays`, defaulting to the last 30 days. */
  private snapshotRange(from?: string, to?: string, maxDays = 366) {
    const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const end = isDate(to) ? new Date(`${to}T00:00:00Z`) : new Date();
    const defaultStart = new Date(end.getTime() - 29 * 86_400_000);
    let start = isDate(from) ? new Date(`${from}T00:00:00Z`) : defaultStart;
    const minStart = new Date(end.getTime() - (maxDays - 1) * 86_400_000);
    if (start < minStart) start = minStart;
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return { from: fmt(start), to: fmt(end) };
  }

  async getProtocolSnapshots(from?: string, to?: string) {
    const range = this.snapshotRange(from, to);
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `
      SELECT to_char("snapshotDate", 'YYYY-MM-DD') AS "snapshotDate",
             "protocolTvl"::text AS "protocolTvl", "tvlByToken", "activeCalls",
             "callsCreated", "callsResolved", "stakesPlaced",
             "dailyVolume"::text AS "dailyVolume", "dailyActiveUsers", "totalUsers",
             "userSnapshotCount"
      FROM daily_protocol_snapshots
      WHERE "snapshotDate" BETWEEN $1 AND $2
      ORDER BY "snapshotDate" ASC
      `,
      [range.from, range.to],
    );
    return { ...range, data: rows };
  }

  async getUserSnapshots(userAddress: string, from?: string, to?: string) {
    const range = this.snapshotRange(from, to);
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `
      SELECT to_char("snapshotDate", 'YYYY-MM-DD') AS "snapshotDate",
             "reputationScore"::text AS "reputationScore", "categoryScores",
             tvl::text AS tvl, "activeStakeCount",
             "lifetimeVolume"::text AS "lifetimeVolume", "dailyVolume"::text AS "dailyVolume",
             wins, losses, "realizedProfit"::text AS "realizedProfit", "leaderboardRank"
      FROM daily_user_snapshots
      WHERE "userAddress" = $1 AND "snapshotDate" BETWEEN $2 AND $3
      ORDER BY "snapshotDate" ASC
      `,
      [userAddress, range.from, range.to],
    );
    return { userAddress, ...range, data: rows };
  }

  /** Point-in-time leaderboard as frozen at the end of `date`. */
  async getLeaderboardSnapshot(date: string, page = 1, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    const offset = (Math.max(page, 1) - 1) * take;
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `
      SELECT "leaderboardRank" AS rank, "userAddress",
             "realizedProfit"::text AS "realizedProfit",
             "reputationScore"::text AS "reputationScore", wins, losses
      FROM daily_user_snapshots
      WHERE "snapshotDate" = $1 AND "leaderboardRank" > $2
      ORDER BY "leaderboardRank" ASC
      LIMIT $3
      `,
      [date, offset, take],
    );
    return {
      snapshotDate: date,
      page: Math.max(page, 1),
      limit: take,
      data: rows,
    };
  }
}
