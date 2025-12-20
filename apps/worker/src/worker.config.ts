import { Job } from 'bullmq';
import { processSaleJob } from './sale.worker';

export interface WorkerConfig {
  queueName: string;
  processor: (job: Job) => Promise<any>;
  concurrency?: number;
  options?: {
    attempts?: number;
    backoff?: {
      type: 'exponential' | 'fixed';
      delay: number;
    };
  };
}

/**
 * Worker registry - Add new workers here
 */
export const WORKERS: WorkerConfig[] = [
  {
    queueName: 'sales',
    processor: processSaleJob,
    concurrency: 5,
    options: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    },
  },
  // Add more workers here as needed:
  // {
  //   queueName: 'inventory',
  //   processor: processInventoryJob,
  //   concurrency: 3,
  // },
];

