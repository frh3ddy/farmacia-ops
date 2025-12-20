import { runConnectionTests } from './test-connection';
import { Worker, Queue, Job } from 'bullmq';
import Redis from 'ioredis';

function getRedisConfig() {
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

function createQueue<T = any>(name: string): Queue<T> {
  const config = getRedisConfig();
  return new Queue<T>(name, {
    connection: {
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    },
  });
}

function createWorker<T = any>(
  queueName: string,
  processor: (job: Job<T>) => Promise<any>
): Worker<T> {
  const config = getRedisConfig();
  return new Worker<T>(
    queueName,
    processor,
    {
      connection: {
        host: config.host,
        port: config.port,
        password: config.password,
        db: config.db,
      },
      concurrency: 5,
    }
  );
}

/**
 * Main worker entry point
 */
async function main() {
  console.log('🚀 Starting Farmacia Ops Worker...\n');

  // Run connection tests on startup
  console.log('Running connection tests...\n');
  const testResults = await runConnectionTests();

  const allTestsPassed = testResults.every(r => r.success);
  if (!allTestsPassed) {
    console.error('❌ Connection tests failed. Worker cannot start.');
    process.exit(1);
  }

  console.log('✅ All connection tests passed. Starting worker...\n');

  // Example: Create a test queue and worker
  const testQueue = createQueue('test-queue');
  const testWorker = createWorker('test-queue', async (job: Job) => {
    console.log(`Processing job ${job.id}:`, job.data);
    return { processed: true, jobId: job.id };
  });

  // Handle worker events
  testWorker.on('completed', (job) => {
    console.log(`✅ Job ${job.id} completed`);
  });

  testWorker.on('failed', (job, err) => {
    console.error(`❌ Job ${job?.id} failed:`, err.message);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down worker...');
    await testWorker.close();
    await testQueue.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log('👂 Worker is listening for jobs...\n');
}

// Run worker
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

