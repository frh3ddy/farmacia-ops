import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const FAILED_JOB_RETENTION_SECONDS = 30 * 24 * 60 * 60;

@Injectable()
export class SaleQueue {
  private readonly logger = new Logger(SaleQueue.name);
  private queue: Queue;

  constructor() {
    const connection = new IORedis(process.env.REDIS_URL!);

    this.queue = new Queue('sales', {
      connection: connection as any,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        // Keep failed sales for 30 days so they can be inspected and replayed
        // (job.retry()). `true` deleted them after the last attempt, losing the
        // sale with no record. While kept, a re-delivered event with the same
        // jobId is a no-op add — replay the failed job instead.
        removeOnFail: { age: FAILED_JOB_RETENTION_SECONDS },
      },
    });
  }

  async enqueue(event: any) {
    this.logger.debug(`Enqueueing event: ${JSON.stringify({
      event_id: event.event_id,
      type: event.type,
      hasData: !!event.data,
    })}`);

    const job = await this.queue.add(
      'process-sale',
      {
        squareEventId: event.event_id,
        payload: event.data,
      },
      {
        jobId: event.event_id, // ⬅️ idempotency
      },
    );

    this.logger.debug(`Job enqueued: ${job.id} (queue: sales)`);

    return job;
  }

  /** A custom-amount line matched to a product; the worker takes its stock and cost. */
  async enqueueMatch(data: { lineId: string; productId: string; matchedBy: string }) {
    // No jobId: the worker's conditional update keeps a line from matching twice,
    // and a fixed id would block a retry while a failed match is kept.
    return this.queue.add('match-sale-line', data);
  }
}
