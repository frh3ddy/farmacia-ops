import { Job, Queue } from 'bullmq';
import { getPrisma, processMatchJob, processRefundJob, processReturnJob, processSaleJob } from './sale.worker';
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
      // Matching a custom amount, a return and a Square refund change a sale, so they share this queue.
      if (job.name === 'match-sale-line') return processMatchJob(job);
      if (job.name === 'record-return') return processReturnJob(job);
      if (job.name === 'square-refund') return processRefundJob(job);
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
  {
    // Nightly end-of-day stock for stock alerts (apps/api/src/stock-alerts/stock-days.ts).
    // One attempt: the next night fills any day this one missed.
    queueName: 'stock-days',
    processor: () => postInternal('/internal/stock-alerts/stock-days'),
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

/** A worker-only api route, over Railway's private network. */
async function postInternal(path: string): Promise<unknown> {
  const url = process.env.API_INTERNAL_URL;
  const secret = process.env.WORKER_API_SECRET;
  if (!url || !secret) throw new Error('API_INTERNAL_URL or WORKER_API_SECRET is not set');
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'x-worker-secret': secret },
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`api answered ${response.status} for ${path}`);
  return response.json();
}
