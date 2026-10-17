import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/**
 * Directed social-graph edge (BE-034). Every co-staking event writes both
 * directions, so rows for (A, B) and (B, A) always carry identical counts.
 */
@Entity('user_interactions')
@Index('IDX_user_interactions_user_co', ['userAddress', 'coBackCount'])
@Index('IDX_user_interactions_user_counter', [
  'userAddress',
  'counterBackCount',
])
export class UserInteraction {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  userAddress: string;

  @PrimaryColumn({ type: 'varchar', length: 128 })
  counterpartAddress: string;

  /** Calls where both backed the same side. */
  @Column({ type: 'int', default: 0 })
  coBackCount: number;

  /** Calls where they backed opposite sides. */
  @Column({ type: 'int', default: 0 })
  counterBackCount: number;

  @Column({ type: 'timestamptz' })
  lastInteractionAt: Date;
}

/**
 * Ledger of each user's first position per call. Its primary key makes the
 * interaction indexer idempotent: a (call, user) pair is only counted once.
 */
@Entity('social_call_positions')
export class SocialCallPosition {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  callId: string;

  @PrimaryColumn({ type: 'varchar', length: 128 })
  userAddress: string;

  @Column({ type: 'varchar', length: 3 })
  position: 'YES' | 'NO';

  @Column({ type: 'timestamptz' })
  indexedAt: Date;
}
