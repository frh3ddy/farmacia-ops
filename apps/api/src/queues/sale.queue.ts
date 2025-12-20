import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

@Injectable()
export class SaleQueue {
  private queue: Queue;

  constructor() {
    const connection = new IORedis(process.env.REDIS_URL!);

    this.queue = new Queue('sales', {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
      },
    });
  }

  async enqueue(event: any) {
    await this.queue.add(
      'process-sale',
      {
        squareEventId: event.event_id,
        payload: event.data,
      },
      {
        jobId: event.event_id, // ⬅️ idempotency
      },
    );
  }
}