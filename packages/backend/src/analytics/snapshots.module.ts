import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueuesModule } from '../common/queues/queues.module';
import {
  DailyProtocolSnapshotEntity,
  DailyUserSnapshotEntity,
} from './entities/daily-snapshot.entity';
import { DailySnapshotService } from './daily-snapshot.service';
import { DailySnapshotProcessor } from './daily-snapshot.processor';
import { SnapshotsController } from './snapshots.controller';

/** BE-036 — midnight UTC historical snapshot generator. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DailyUserSnapshotEntity,
      DailyProtocolSnapshotEntity,
    ]),
    QueuesModule,
  ],
  controllers: [SnapshotsController],
  providers: [DailySnapshotService, DailySnapshotProcessor],
  exports: [DailySnapshotService],
})
export class SnapshotsModule {}
