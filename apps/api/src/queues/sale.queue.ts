import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

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
        removeOnFail: true, // Remove failed jobs so they don't block retries with same jobId
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
}