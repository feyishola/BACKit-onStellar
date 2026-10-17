import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-034 — follow counters, co-backing interaction graph, feed index.
 * Idempotent (IF NOT EXISTS) so it is safe on dev databases that were
 * already synchronised from the entities.
 */
export class SocialGraphAffinity1760000081000 implements MigrationInterface {
  name = 'SocialGraphAffinity1760000081000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "followerCount" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "followingCount" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      UPDATE "users" u SET
        "followerCount" = (SELECT COUNT(*) FROM "follows" f WHERE f."followingAddress" = u."walletAddress"),
        "followingCount" = (SELECT COUNT(*) FROM "follows" f WHERE f."followerAddress" = u."walletAddress")
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_interactions" (
        "userAddress" varchar(128) NOT NULL,
        "counterpartAddress" varchar(128) NOT NULL,
        "coBackCount" integer NOT NULL DEFAULT 0,
        "counterBackCount" integer NOT NULL DEFAULT 0,
        "lastInteractionAt" timestamptz NOT NULL,
        PRIMARY KEY ("userAddress", "counterpartAddress")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_interactions_user_co" ON "user_interactions" ("userAddress", "coBackCount")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_interactions_user_counter" ON "user_interactions" ("userAddress", "counterBackCount")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "social_call_positions" (
        "callId" varchar(64) NOT NULL,
        "userAddress" varchar(128) NOT NULL,
        "position" varchar(3) NOT NULL,
        "indexedAt" timestamptz NOT NULL,
        PRIMARY KEY ("callId", "userAddress")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_activity_user_created" ON "activity" ("userAddress", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_activity_user_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "social_call_positions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_interactions"`);
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "followerCount",
        DROP COLUMN IF EXISTS "followingCount"
    `);
  }
}
