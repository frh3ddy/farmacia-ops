import { Job, Queue } from 'bullmq';
import { getPrisma, processSaleJob } from './sale.worker';
import { integrityDeps, runIntegrityChecks } from './integrity-run';
import { debugLog } from './debug-log';

export interface WorkerConfig {
  queueName: string;
  /** queue(name): another registered queue, e.g. the integrity job reads the sales queue's failed jobs. */
  processor: (job: Job, queue: (name: string) => Queue) => Promise<any>;
  concurrency?: number;
  /** Repeat this queue's job on a cron pattern (BullMQ job scheduler). */
  schedule?: { pattern: string; tz: string };
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
      debugLog('[DEBUG] [WORKER_CONFIG] Sales worker processor called for job:', job.id);
      debugLog('[DEBUG] [WORKER_CONFIG] Job data keys:', Object.keys(job.data || {}));
      return processSaleJob(job);
    },
    concurrency: 5,
    // Retries come from the api, which queues these jobs (apps/api/src/queues/sale.queue.ts).
  },
  {
    // Nightly integrity check (tasks/inventory-integrity-epic.md). One attempt:
    // a failed run is recorded and the next night's run tries again.
    queueName: 'integrity',
    processor: async (_job: Job, queue) => {
      await runIntegrityChecks(integrityDeps(getPrisma(), queue('sales')));
    },
    concurrency: 1,
    schedule: { pattern: '0 3 * * *', tz: 'America/Mexico_City' },
    options: { attempts: 1 },
  },
  // Add more workers here as needed:
  // {
  //   queueName: 'inventory',
  //   processor: processInventoryJob,
  //   concurrency: 3,
  // },
];

