import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-036 — immutable daily user and protocol snapshot tables.
 * Idempotent (IF NOT EXISTS) so it is safe on dev databases that were
 * already synchronised from the entities.
 */
export class DailySnapshots1760000082000 implements MigrationInterface {
  name = 'DailySnapshots1760000082000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "daily_user_snapshots" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "snapshotDate" date NOT NULL,
        "userAddress" varchar(128) NOT NULL,
        "reputationScore" numeric(12,4) NOT NULL DEFAULT 0,
        "categoryScores" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "tvl" numeric(30,10) NOT NULL DEFAULT 0,
        "activeStakeCount" integer NOT NULL DEFAULT 0,
        "lifetimeVolume" numeric(30,10) NOT NULL DEFAULT 0,
        "dailyVolume" numeric(30,10) NOT NULL DEFAULT 0,
        "wins" integer NOT NULL DEFAULT 0,
        "losses" integer NOT NULL DEFAULT 0,
        "realizedProfit" numeric(30,10) NOT NULL DEFAULT 0,
        "leaderboardRank" integer NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_daily_user_snapshot_date_user" UNIQUE ("snapshotDate", "userAddress")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_daily_user_snapshot_user_date" ON "daily_user_snapshots" ("userAddress", "snapshotDate")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_daily_user_snapshot_date_rank" ON "daily_user_snapshots" ("snapshotDate", "leaderboardRank")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "daily_protocol_snapshots" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "snapshotDate" date NOT NULL,
        "protocolTvl" numeric(30,10) NOT NULL DEFAULT 0,
        "tvlByToken" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "activeCalls" integer NOT NULL DEFAULT 0,
        "callsCreated" integer NOT NULL DEFAULT 0,
        "callsResolved" integer NOT NULL DEFAULT 0,
        "stakesPlaced" integer NOT NULL DEFAULT 0,
        "dailyVolume" numeric(30,10) NOT NULL DEFAULT 0,
        "dailyActiveUsers" integer NOT NULL DEFAULT 0,
        "totalUsers" integer NOT NULL DEFAULT 0,
        "leaderboardTop" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "userSnapshotCount" integer NOT NULL DEFAULT 0,
        "generationMs" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_daily_protocol_snapshot_date" UNIQUE ("snapshotDate")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "daily_protocol_snapshots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "daily_user_snapshots"`);
  }
}
