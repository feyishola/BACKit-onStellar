import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

export interface LeaderboardStanding {
  rank: number;
  userAddress: string;
  realizedProfit: string;
  reputation: string;
}

/**
 * Immutable end-of-day state per user (BE-036). Rows are insert-only: the
 * generator uses ON CONFLICT DO NOTHING so reruns never rewrite history.
 */
@Entity('daily_user_snapshots')
@Unique('UQ_daily_user_snapshot_date_user', ['snapshotDate', 'userAddress'])
@Index('IDX_daily_user_snapshot_user_date', ['userAddress', 'snapshotDate'])
@Index('IDX_daily_user_snapshot_date_rank', ['snapshotDate', 'leaderboardRank'])
export class DailyUserSnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** UTC calendar day the snapshot describes (state as of the end of that day). */
  @Column({ type: 'date' })
  snapshotDate: string;

  @Column({ type: 'varchar', length: 128 })
  userAddress: string;

  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  reputationScore: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  categoryScores: Record<string, unknown>;

  /** Sum of stakes on calls still unresolved at the cutoff, in stake-token units. */
  @Column({ type: 'decimal', precision: 30, scale: 10, default: 0 })
  tvl: string;

  @Column({ type: 'int', default: 0 })
  activeStakeCount: number;

  @Column({ type: 'decimal', precision: 30, scale: 10, default: 0 })
  lifetimeVolume: string;

  @Column({ type: 'decimal', precision: 30, scale: 10, default: 0 })
  dailyVolume: string;

  @Column({ type: 'int', default: 0 })
  wins: number;

  @Column({ type: 'int', default: 0 })
  losses: number;

  @Column({ type: 'decimal', precision: 30, scale: 10, default: 0 })
  realizedProfit: string;

  @Column({ type: 'int' })
  leaderboardRank: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** Immutable end-of-day protocol aggregates (BE-036). One row per UTC day. */
@Entity('daily_protocol_snapshots')
@Unique('UQ_daily_protocol_snapshot_date', ['snapshotDate'])
export class DailyProtocolSnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'date' })
  snapshotDate: string;

  @Column({ type: 'decimal', precision: 30, scale: 10, default: 0 })
  protocolTvl: string;

  /** TVL keyed by stake token (or "NATIVE" when unset). */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  tvlByToken: Record<string, string>;

  @Column({ type: 'int', default: 0 })
  activeCalls: number;

  @Column({ type: 'int', default: 0 })
  callsCreated: number;

  @Column({ type: 'int', default: 0 })
  callsResolved: number;

  @Column({ type: 'int', default: 0 })
  stakesPlaced: number;

  @Column({ type: 'decimal', precision: 30, scale: 10, default: 0 })
  dailyVolume: string;

  @Column({ type: 'int', default: 0 })
  dailyActiveUsers: number;

  @Column({ type: 'int', default: 0 })
  totalUsers: number;

  /** Top standings frozen at the cutoff. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  leaderboardTop: LeaderboardStanding[];

  @Column({ type: 'int', default: 0 })
  userSnapshotCount: number;

  @Column({ type: 'int', default: 0 })
  generationMs: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
