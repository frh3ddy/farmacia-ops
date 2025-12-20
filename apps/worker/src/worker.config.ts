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
    processor: (job: Job) => {
      console.log('[DEBUG] [WORKER_CONFIG] Sales worker processor called for job:', job.id);
      console.log('[DEBUG] [WORKER_CONFIG] Job data keys:', Object.keys(job.data || {}));
      return processSaleJob(job);
    },
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

