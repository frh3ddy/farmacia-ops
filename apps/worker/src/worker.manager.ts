import { Worker, Queue, Job } from 'bullmq';
import { WorkerConfig, WORKERS } from './worker.config';
import { debugLog } from './debug-log';
import { describeFailedJob } from './failed-job';

interface ManagedWorker {
  config: WorkerConfig;
  queue: Queue;
  worker: Worker;
}

export class WorkerManager {
  private workers: ManagedWorker[] = [];
  private redisConfig: { host: string; port: number; password?: string; db: number };

  constructor() {
    debugLog('[DEBUG] [WORKER_MANAGER] Initializing WorkerManager');
    this.redisConfig = this.getRedisConfig();
    debugLog('[DEBUG] [WORKER_MANAGER] Redis config loaded');
  }

  private getRedisConfig() {
    debugLog('[DEBUG] [WORKER_MANAGER] Getting Redis configuration');
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      console.error('[DEBUG] [WORKER_MANAGER] ERROR: REDIS_URL not set');
      throw new Error('REDIS_URL environment variable is not set');
    }
    debugLog('[DEBUG] [WORKER_MANAGER] REDIS_URL found (masked)');
    const url = new URL(redisUrl);
    const config = {
      host: url.hostname,
      port: parseInt(url.port || '6379', 10),
      password: url.password || undefined,
      db: url.pathname ? parseInt(url.pathname.slice(1), 10) : 0,
    };
    debugLog('[DEBUG] [WORKER_MANAGER] Redis config parsed:', {
      host: config.host,
      port: config.port,
      db: config.db,
      hasPassword: !!config.password,
    });
    return config;
  }

  /**
   * Initialize and start all registered workers
   */
  async startAll() {
    debugLog('[DEBUG] [WORKER_MANAGER] ========================================');
    debugLog('[DEBUG] [WORKER_MANAGER] Starting worker initialization');
    debugLog(`[DEBUG] [WORKER_MANAGER] Registering ${WORKERS.length} worker(s)...\n`);

    for (const config of WORKERS) {
      debugLog(`[DEBUG] [WORKER_MANAGER] Creating worker for queue: ${config.queueName}`);
      const managedWorker = await this.createWorker(config);
      this.workers.push(managedWorker);
      this.setupWorkerEvents(managedWorker);
      debugLog(`[DEBUG] [WORKER_MANAGER] ✅ Registered worker: ${config.queueName}`);

      // Upsert, keyed by queue name: restarts and deploys keep one schedule.
      if (config.schedule) {
        await managedWorker.queue.upsertJobScheduler(`${config.queueName}-nightly`, config.schedule, { name: config.queueName });
        console.log(`[WORKER_MANAGER] ${config.queueName} scheduled: ${config.schedule.pattern} (${config.schedule.tz})`);
      }

      // Check queue status
      try {
        const waiting = await managedWorker.queue.getWaitingCount();
        const active = await managedWorker.queue.getActiveCount();
        const completed = await managedWorker.queue.getCompletedCount();
        const failed = await managedWorker.queue.getFailedCount();
        debugLog(`[DEBUG] [WORKER_MANAGER] Queue ${config.queueName} status:`, {
          waiting,
          active,
          completed,
          failed,
        });
        
        if (waiting > 0) {
          debugLog(`[DEBUG] [WORKER_MANAGER] ⚠️ Found ${waiting} waiting jobs in queue ${config.queueName}`);
        }
        
        if (failed > 0) {
          debugLog(`[DEBUG] [WORKER_MANAGER] ⚠️ Found ${failed} failed jobs in queue ${config.queueName}`);
          // Get failed jobs to show details
          const failedJobs = await managedWorker.queue.getFailed(0, failed);
          for (const failedJob of failedJobs) {
            // getFailed() returns undefined for a failed id whose job data is gone.
            if (!failedJob) {
              console.error(`[WORKER_MANAGER] A failed job in ${config.queueName} has no data left (expired or removed)`);
              continue;
            }
            console.error(`[WORKER_MANAGER] Failed job in ${config.queueName}:`, describeFailedJob(failedJob));
          }
        }
      } catch (error) {
        console.error(`[DEBUG] [WORKER_MANAGER] Error checking queue status:`, error);
      }
    }

    debugLog(`[DEBUG] [WORKER_MANAGER] 👂 All workers are listening for jobs...\n`);
    debugLog('[DEBUG] [WORKER_MANAGER] ========================================');
  }

  private queueFor(name: string): Queue {
    const managed = this.workers.find((w) => w.config.queueName === name);
    if (!managed) throw new Error(`No registered queue "${name}"`);
    return managed.queue;
  }

  /**
   * Create a worker and its associated queue
   */
  private async createWorker(config: WorkerConfig): Promise<ManagedWorker> {
    debugLog(`[DEBUG] [WORKER_MANAGER] Creating queue: ${config.queueName}`);
    debugLog(`[DEBUG] [WORKER_MANAGER] Redis config:`, {
      host: this.redisConfig.host,
      port: this.redisConfig.port,
      db: this.redisConfig.db,
    });
    
    const queue = new Queue(config.queueName, {
      connection: this.redisConfig,
      defaultJobOptions: {
        attempts: config.options?.attempts ?? 3,
        backoff: config.options?.backoff ?? {
          type: 'exponential',
          delay: 2000,
        },
      },
    });
    debugLog(`[DEBUG] [WORKER_MANAGER] Queue created: ${config.queueName}`);

    debugLog(`[DEBUG] [WORKER_MANAGER] Creating worker: ${config.queueName}`);
    debugLog(`[DEBUG] [WORKER_MANAGER] Worker concurrency: ${config.concurrency ?? 5}`);
    
    const worker = new Worker(
      config.queueName,
      (job) => config.processor(job, (name) => this.queueFor(name)),
      {
        connection: this.redisConfig,
        concurrency: config.concurrency ?? 5,
      }
    );
    debugLog(`[DEBUG] [WORKER_MANAGER] Worker created: ${config.queueName}`);

    // Add 'ready' event to confirm worker is listening
    worker.on('ready', () => {
      debugLog(`[DEBUG] [WORKER_MANAGER] ✅ Worker ${config.queueName} is ready and listening for jobs`);
    });

    // Add 'closing' event
    worker.on('closing', () => {
      debugLog(`[DEBUG] [WORKER_MANAGER] Worker ${config.queueName} is closing`);
    });

    // Add 'closed' event
    worker.on('closed', () => {
      debugLog(`[DEBUG] [WORKER_MANAGER] Worker ${config.queueName} is closed`);
    });

    return { config, queue, worker };
  }

  /**
   * Setup event handlers for a worker
   */
  private setupWorkerEvents(managed: ManagedWorker) {
    const { worker, config } = managed;

    debugLog(`[DEBUG] [WORKER_MANAGER] Setting up event handlers for: ${config.queueName}`);

    worker.on('active', (job) => {
      debugLog(`[DEBUG] [WORKER_MANAGER] 🔄 [${config.queueName}] Job ${job.id} started`);
      debugLog(`[DEBUG] [WORKER_MANAGER] Job ${job.id} data:`, JSON.stringify(job.data, null, 2));
    });

    worker.on('completed', (job, result) => {
      debugLog(`[DEBUG] [WORKER_MANAGER] ✅ [${config.queueName}] Job ${job.id} completed`);
      debugLog(`[DEBUG] [WORKER_MANAGER] Job ${job.id} result:`, result);
    });

    worker.on('failed', (job, err) => {
      console.error(`[WORKER_MANAGER] ❌ [${config.queueName}] Job failed:`, describeFailedJob(job ?? {}, err));
      debugLog(err.stack);
    });

    worker.on('error', (err) => {
      console.error(`[DEBUG] [WORKER_MANAGER] 💥 [${config.queueName}] Worker error`);
      console.error(`[DEBUG] [WORKER_MANAGER] Error message:`, err.message);
      console.error(`[DEBUG] [WORKER_MANAGER] Error stack:`, err.stack);
    });

    worker.on('stalled', (jobId) => {
      console.warn(`[DEBUG] [WORKER_MANAGER] ⚠️ [${config.queueName}] Job ${jobId} stalled`);
    });

    worker.on('progress', (job, progress) => {
      debugLog(`[DEBUG] [WORKER_MANAGER] 📊 [${config.queueName}] Job ${job.id} progress:`, progress);
    });

    debugLog(`[DEBUG] [WORKER_MANAGER] Event handlers set up for: ${config.queueName}`);
  }

  /**
   * Gracefully shutdown all workers
   */
  async shutdown() {
    console.log('\n🛑 Shutting down all workers...');
    
    const shutdownPromises = this.workers.map(async (managed) => {
      try {
        await managed.worker.close();
        await managed.queue.close();
        console.log(`✅ [${managed.config.queueName}] Worker stopped`);
      } catch (error) {
        console.error(`❌ [${managed.config.queueName}] Error during shutdown:`, error);
      }
    });

    await Promise.all(shutdownPromises);
    console.log('✅ All workers stopped');
  }
}

