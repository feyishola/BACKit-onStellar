import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserReputation } from './entities/user-reputation.entity';
import { ReputationDecayService } from './reputation-decay.service';
import { ReputationController } from './reputation.controller';

/** BE-032 — nightly category expertise indexing and inactivity decay. */
@Module({
  imports: [TypeOrmModule.forFeature([UserReputation])],
  controllers: [ReputationController],
  providers: [ReputationDecayService],
  exports: [ReputationDecayService],
})
export class ReputationModule {}
