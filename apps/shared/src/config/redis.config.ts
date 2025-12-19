import Redis, { RedisOptions } from 'ioredis';

/**
 * Get Redis connection options from environment variables
 * Compatible with Railway's REDIS_URL format
 */
export function getRedisConfig(): RedisOptions {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable is not set');
  }

  // Parse Redis URL (format: redis://[:password@]host[:port][/db])
  try {
    const url = new URL(redisUrl);
    
    const config: RedisOptions = {
      host: url.hostname,
      port: parseInt(url.port || '6379', 10),
      password: url.password || undefined,
      db: url.pathname ? parseInt(url.pathname.slice(1), 10) : 0,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      enableOfflineQueue: false,
    };

    return config;
  } catch (error) {
    throw new Error(`Invalid REDIS_URL format: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Create a Redis connection instance
 */
export function createRedisConnection(): Redis {
  const config = getRedisConfig();
  return new Redis(config);
}

/**
 * Test Redis connection
 */
export async function testRedisConnection(redis?: Redis): Promise<boolean> {
  const client = redis || createRedisConnection();
  
  try {
    const result = await client.ping();
    if (!redis) {
      await client.quit();
    }
    return result === 'PONG';
  } catch (error) {
    if (!redis) {
      await client.quit().catch(() => {});
    }
    throw error;
  }
}

