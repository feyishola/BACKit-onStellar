import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { QUEUE_ANALYTICS_SNAPSHOTS } from '../common/queues/queues.constants';
import {
  DAILY_SNAPSHOT_CRON,
  DAILY_SNAPSHOT_JOB,
  DAILY_SNAPSHOT_SCHEDULER_ID,
  DailySnapshotResult,
  DailySnapshotService,
  snapshotDateForFireTime,
} from './daily-snapshot.service';

export interface DailySnapshotJobData {
  /** Explicit YYYY-MM-DD for backfills; omitted by the midnight scheduler. */
  snapshotDate?: string;
}

/** Resolves which UTC day a job should snapshot. */
export function resolveSnapshotDate(job: Job<DailySnapshotJobData>): string {
  if (job.data?.snapshotDate) return job.data.snapshotDate;
  // Scheduler jobs are enqueued ahead of time with a delay; timestamp + delay
  // is the exact 00:00:00 UTC fire time, independent of worker lag.
  const fireAt = job.timestamp + (job.opts?.delay ?? 0);
  return snapshotDateForFireTime(new Date(fireAt));
}

@Processor(QUEUE_ANALYTICS_SNAPSHOTS)
export class DailySnapshotProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(DailySnapshotProcessor.name);

  constructor(
    private readonly snapshotService: DailySnapshotService,
    @InjectQueue(QUEUE_ANALYTICS_SNAPSHOTS) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      // Upsert keeps a single scheduler across restarts and replicas.
      await this.queue.upsertJobScheduler(
        DAILY_SNAPSHOT_SCHEDULER_ID,
        { pattern: DAILY_SNAPSHOT_CRON, tz: 'UTC' },
        { name: DAILY_SNAPSHOT_JOB, data: {} },
      );
      // Catch up on yesterday if the process was down at midnight; the
      // deterministic jobId and the service's idempotency make this a no-op otherwise.
      const yesterday = snapshotDateForFireTime(new Date());
      await this.enqueue(yesterday);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to register daily snapshot scheduler: ${msg}`);
    }
  }

  enqueue(snapshotDate: string) {
    return this.queue.add(
      DAILY_SNAPSHOT_JOB,
      { snapshotDate },
      { jobId: `${DAILY_SNAPSHOT_JOB}-${snapshotDate}` },
    );
  }

  async process(job: Job<DailySnapshotJobData>): Promise<DailySnapshotResult> {
    const snapshotDate = resolveSnapshotDate(job);
    this.logger.log(`Generating daily snapshot for ${snapshotDate}`);
    return this.snapshotService.generate(snapshotDate);
  }
}
