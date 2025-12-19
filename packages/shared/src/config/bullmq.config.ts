import { Queue, QueueOptions, Worker, WorkerOptions, Job } from 'bullmq';
import { createRedisConnection, getRedisConfig } from './redis.config';

/**
 * Get BullMQ connection options using Redis configuration
 */
export function getBullMQConnection() {
  const redisConfig = getRedisConfig();
  return {
    host: redisConfig.host,
    port: redisConfig.port,
    password: redisConfig.password,
    db: redisConfig.db,
  };
}

/**
 * Create a BullMQ queue with default configuration
 */
export function createQueue<T = any>(
  name: string,
  options?: Partial<QueueOptions>
): Queue<T> {
  const connection = getBullMQConnection();
  
  return new Queue<T>(name, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: {
        age: 24 * 3600, // 24 hours
        count: 1000,
      },
      removeOnFail: {
        age: 7 * 24 * 3600, // 7 days
      },
    },
    ...options,
  });
}

/**
 * Create a BullMQ worker with default configuration
 */
export function createWorker<T = any>(
  queueName: string,
  processor: (job: Job<T>) => Promise<any>,
  options?: Partial<WorkerOptions>
): Worker<T> {
  const connection = getBullMQConnection();
  
  return new Worker<T>(
    queueName,
    processor,
    {
      connection,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 1000,
      },
      ...options,
    }
  );
}

/**
 * Test BullMQ queue creation and basic operations
 */
export async function testBullMQConnection(queueName: string = 'test-queue'): Promise<boolean> {
  let queue: Queue | null = null;
  
  try {
    // Test queue creation
    queue = createQueue(queueName);
    
    // Test adding a job
    const job = await queue.add('test-job', { test: true });
    
    // Wait a bit for job to be processed
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check job status
    const jobState = await job.getState();
    
    // Clean up test queue
    await queue.obliterate({ force: true });
    await queue.close();
    
    return jobState !== undefined;
  } catch (error) {
    if (queue) {
      try {
        await queue.obliterate({ force: true });
        await queue.close();
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
    throw error;
  }
}

