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
    this.redisConfig = this.getRedisConfig();
  }

  private getRedisConfig() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not set');
    }
    const url = new URL(redisUrl);
    return {
      host: url.hostname,
      port: parseInt(url.port || '6379', 10),
      password: url.password || undefined,
      db: url.pathname ? parseInt(url.pathname.slice(1), 10) : 0,
    };
  }

  /**
   * Initialize and start all registered workers
   */
  async startAll() {
    console.log(`📋 Registering ${WORKERS.length} worker(s)...\n`);

    for (const config of WORKERS) {
      const managedWorker = await this.createWorker(config);
      this.workers.push(managedWorker);
      this.setupWorkerEvents(managedWorker);
      console.log(`✅ Registered worker: ${config.queueName}`);
    }

    console.log(`\n👂 All workers are listening for jobs...\n`);
  }

  /**
   * Create a worker and its associated queue
   */
  private async createWorker(config: WorkerConfig): Promise<ManagedWorker> {
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

    const worker = new Worker(
      config.queueName,
      config.processor,
      {
        connection: this.redisConfig,
        concurrency: config.concurrency ?? 5,
      }
    );

    return { config, queue, worker };
  }

  /**
   * Setup event handlers for a worker
   */
  private setupWorkerEvents(managed: ManagedWorker) {
    const { worker, config } = managed;

    worker.on('active', (job) => {
      console.log(`🔄 [${config.queueName}] Job ${job.id} started`);
    });

    worker.on('completed', (job) => {
      console.log(`✅ [${config.queueName}] Job ${job.id} completed`);
    });

    worker.on('failed', (job, err) => {
      console.error(`❌ [${config.queueName}] Job ${job?.id} failed:`, err.message);
    });

    worker.on('error', (err) => {
      console.error(`💥 [${config.queueName}] Worker error:`, err.message);
    });
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

