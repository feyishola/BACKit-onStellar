import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('treasury_entries')
@Index('IDX_treasury_token_collected', ['tokenAddress', 'collectedAt'])
@Index('IDX_treasury_call_collected', ['callId', 'collectedAt'])
@Index('IDX_treasury_collected', ['collectedAt'])
export class TreasuryEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  callId: string;

  @Column({ type: 'decimal', precision: 20, scale: 7 })
  feeAmount: string;

  @Column({ type: 'varchar', length: 56 })
  tokenAddress: string;

  @Column({ type: 'timestamp' })
  collectedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
