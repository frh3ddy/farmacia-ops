import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

@Injectable()
export class SaleQueue {
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
    console.log('[DEBUG] [SALE_QUEUE] Enqueueing event:', {
      event_id: event.event_id,
      type: event.type,
      hasData: !!event.data,
    });
    
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
    
    console.log('[DEBUG] [SALE_QUEUE] ✅ Job enqueued:', {
      jobId: job.id,
      name: job.name,
      queueName: 'sales',
    });
    
    return job;
  }
}