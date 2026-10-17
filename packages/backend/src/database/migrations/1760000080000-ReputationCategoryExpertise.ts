import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-032 — call categories and the nightly user_reputation table.
 * Idempotent (IF NOT EXISTS) so it is safe on dev databases that were
 * already synchronised from the entities.
 */
export class ReputationCategoryExpertise1760000080000 implements MigrationInterface {
  name = 'ReputationCategoryExpertise1760000080000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "category" varchar(16)`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_reputation" (
        "userAddress" varchar(128) PRIMARY KEY,
        "basePoints" numeric(12,4) NOT NULL DEFAULT 0,
        "decayedPoints" numeric(12,4) NOT NULL DEFAULT 0,
        "decayFactor" numeric(10,8) NOT NULL DEFAULT 1,
        "lastActiveAt" timestamptz,
        "categoryScores" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "topCategory" varchar(16),
        "computedAt" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_reputation_decayed" ON "user_reputation" ("decayedPoints")`,
    );
    // Covers the per-user batch scan in ReputationDecayService.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_stakes_user_call_created" ON "stakes" ("userAddress", "callId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_stakes_user_call_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "user_reputation"`);
    await queryRunner.query(
      `ALTER TABLE "calls" DROP COLUMN IF EXISTS "category"`,
    );
  }
}
