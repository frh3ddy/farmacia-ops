import { Worker, Queue, Job } from 'bullmq';
import { WorkerConfig, WORKERS } from './worker.config';

interface ManagedWorker {
  config: WorkerConfig;
  queue: Queue;
  worker: Worker;
}

export class WorkerManager {
  private workers: ManagedWorker[] = [];
  private redisConfig: { host: string; port: number; password?: string; db: number };

  constructor() {
    console.log('[DEBUG] [WORKER_MANAGER] Initializing WorkerManager');
    this.redisConfig = this.getRedisConfig();
    console.log('[DEBUG] [WORKER_MANAGER] Redis config loaded');
  }

  private getRedisConfig() {
    console.log('[DEBUG] [WORKER_MANAGER] Getting Redis configuration');
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      console.error('[DEBUG] [WORKER_MANAGER] ERROR: REDIS_URL not set');
      throw new Error('REDIS_URL environment variable is not set');
    }
    console.log('[DEBUG] [WORKER_MANAGER] REDIS_URL found (masked)');
    const url = new URL(redisUrl);
    const config = {
      host: url.hostname,
      port: parseInt(url.port || '6379', 10),
      password: url.password || undefined,
      db: url.pathname ? parseInt(url.pathname.slice(1), 10) : 0,
    };
    console.log('[DEBUG] [WORKER_MANAGER] Redis config parsed:', {
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
    console.log('[DEBUG] [WORKER_MANAGER] ========================================');
    console.log('[DEBUG] [WORKER_MANAGER] Starting worker initialization');
    console.log(`[DEBUG] [WORKER_MANAGER] Registering ${WORKERS.length} worker(s)...\n`);

    for (const config of WORKERS) {
      console.log(`[DEBUG] [WORKER_MANAGER] Creating worker for queue: ${config.queueName}`);
      const managedWorker = await this.createWorker(config);
      this.workers.push(managedWorker);
      this.setupWorkerEvents(managedWorker);
      console.log(`[DEBUG] [WORKER_MANAGER] ✅ Registered worker: ${config.queueName}`);
      
      // Check queue status
      try {
        const waiting = await managedWorker.queue.getWaitingCount();
        const active = await managedWorker.queue.getActiveCount();
        const completed = await managedWorker.queue.getCompletedCount();
        const failed = await managedWorker.queue.getFailedCount();
        console.log(`[DEBUG] [WORKER_MANAGER] Queue ${config.queueName} status:`, {
          waiting,
          active,
          completed,
          failed,
        });
        
        if (waiting > 0) {
          console.log(`[DEBUG] [WORKER_MANAGER] ⚠️ Found ${waiting} waiting jobs in queue ${config.queueName}`);
        }
      } catch (error) {
        console.error(`[DEBUG] [WORKER_MANAGER] Error checking queue status:`, error);
      }
    }

    console.log(`[DEBUG] [WORKER_MANAGER] 👂 All workers are listening for jobs...\n`);
    console.log('[DEBUG] [WORKER_MANAGER] ========================================');
  }

  /**
   * Create a worker and its associated queue
   */
  private async createWorker(config: WorkerConfig): Promise<ManagedWorker> {
    console.log(`[DEBUG] [WORKER_MANAGER] Creating queue: ${config.queueName}`);
    console.log(`[DEBUG] [WORKER_MANAGER] Redis config:`, {
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
    console.log(`[DEBUG] [WORKER_MANAGER] Queue created: ${config.queueName}`);

    console.log(`[DEBUG] [WORKER_MANAGER] Creating worker: ${config.queueName}`);
    console.log(`[DEBUG] [WORKER_MANAGER] Worker concurrency: ${config.concurrency ?? 5}`);
    
    const worker = new Worker(
      config.queueName,
      config.processor,
      {
        connection: this.redisConfig,
        concurrency: config.concurrency ?? 5,
      }
    );
    console.log(`[DEBUG] [WORKER_MANAGER] Worker created: ${config.queueName}`);

    // Add 'ready' event to confirm worker is listening
    worker.on('ready', () => {
      console.log(`[DEBUG] [WORKER_MANAGER] ✅ Worker ${config.queueName} is ready and listening for jobs`);
    });

    // Add 'closing' event
    worker.on('closing', () => {
      console.log(`[DEBUG] [WORKER_MANAGER] Worker ${config.queueName} is closing`);
    });

    // Add 'closed' event
    worker.on('closed', () => {
      console.log(`[DEBUG] [WORKER_MANAGER] Worker ${config.queueName} is closed`);
    });

    return { config, queue, worker };
  }

  /**
   * Setup event handlers for a worker
   */
  private setupWorkerEvents(managed: ManagedWorker) {
    const { worker, config } = managed;

    console.log(`[DEBUG] [WORKER_MANAGER] Setting up event handlers for: ${config.queueName}`);

    worker.on('active', (job) => {
      console.log(`[DEBUG] [WORKER_MANAGER] 🔄 [${config.queueName}] Job ${job.id} started`);
      console.log(`[DEBUG] [WORKER_MANAGER] Job ${job.id} data:`, JSON.stringify(job.data, null, 2));
    });

    worker.on('completed', (job, result) => {
      console.log(`[DEBUG] [WORKER_MANAGER] ✅ [${config.queueName}] Job ${job.id} completed`);
      console.log(`[DEBUG] [WORKER_MANAGER] Job ${job.id} result:`, result);
    });

    worker.on('failed', (job, err) => {
      console.error(`[DEBUG] [WORKER_MANAGER] ❌ [${config.queueName}] Job ${job?.id} failed`);
      console.error(`[DEBUG] [WORKER_MANAGER] Error message:`, err.message);
      console.error(`[DEBUG] [WORKER_MANAGER] Error stack:`, err.stack);
      if (job) {
        console.error(`[DEBUG] [WORKER_MANAGER] Failed job data:`, JSON.stringify(job.data, null, 2));
        console.error(`[DEBUG] [WORKER_MANAGER] Failed job attemptsMade:`, job.attemptsMade);
        console.error(`[DEBUG] [WORKER_MANAGER] Failed job opts.attempts:`, job.opts.attempts);
      }
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
      console.log(`[DEBUG] [WORKER_MANAGER] 📊 [${config.queueName}] Job ${job.id} progress:`, progress);
    });

    console.log(`[DEBUG] [WORKER_MANAGER] Event handlers set up for: ${config.queueName}`);
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

