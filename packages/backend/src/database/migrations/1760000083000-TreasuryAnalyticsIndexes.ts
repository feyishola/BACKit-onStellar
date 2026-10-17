import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-033 — range index for fee time series; the existing composite
 * (tokenAddress, collectedAt) index cannot serve token-agnostic ranges.
 */
export class TreasuryAnalyticsIndexes1760000083000 implements MigrationInterface {
  name = 'TreasuryAnalyticsIndexes1760000083000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_treasury_collected" ON "treasury_entries" ("collectedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_treasury_collected"`);
  }
}
