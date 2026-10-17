import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

export enum ExpertiseCategory {
  DEFI = 'DEFI',
  MEMECOINS = 'MEMECOINS',
  AI = 'AI',
  MACRO = 'MACRO',
  OTHER = 'OTHER',
}

export enum ExpertiseTier {
  NOVICE = 'NOVICE',
  APPRENTICE = 'APPRENTICE',
  SKILLED = 'SKILLED',
  EXPERT = 'EXPERT',
  GRANDMASTER = 'GRANDMASTER',
}

export interface CategoryExpertise {
  resolvedCalls: number;
  wins: number;
  winRate: number;
  volume: string;
  volumeWeight: number;
  rawScore: number;
  score: number;
  tier: ExpertiseTier;
}

export type CategoryExpertiseBreakdown = Partial<
  Record<ExpertiseCategory, CategoryExpertise>
>;

/**
 * Nightly materialised reputation state per predictor (BE-032).
 * Written exclusively by ReputationDecayService.
 */
@Entity('user_reputation')
@Index('IDX_user_reputation_decayed', ['decayedPoints'])
export class UserReputation {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  userAddress: string;

  /** Reputation before inactivity decay, 0–100. */
  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  basePoints: string;

  /** Reputation after the 90-day half-life decay, 0–100. */
  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  decayedPoints: string;

  @Column({ type: 'decimal', precision: 10, scale: 8, default: 1 })
  decayFactor: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastActiveAt: Date | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  categoryScores: CategoryExpertiseBreakdown;

  @Column({ type: 'varchar', length: 16, nullable: true })
  topCategory: ExpertiseCategory | null;

  @Column({ type: 'timestamptz' })
  computedAt: Date;
}
