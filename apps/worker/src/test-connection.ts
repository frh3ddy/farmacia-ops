import {
  testRedisConnection,
  testBullMQConnection,
  ConnectionTestResult,
  measureTime,
} from '@farmacia-ops/shared';

/**
 * Test Redis connection
 */
async function testRedis(): Promise<ConnectionTestResult> {
  try {
    const { result, duration } = await measureTime(async () => {
      return await testRedisConnection();
    });

    return {
      service: 'Redis',
      success: result,
      message: result ? 'Redis connection successful' : 'Redis connection failed',
      duration,
    };
  } catch (error) {
    return {
      service: 'Redis',
      success: false,
      message: 'Redis connection failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Test BullMQ connection
 */
async function testBullMQ(): Promise<ConnectionTestResult> {
  try {
    const { result, duration } = await measureTime(async () => {
      return await testBullMQConnection('connection-test-queue');
    });

    return {
      service: 'BullMQ',
      success: result,
      message: result ? 'BullMQ connection successful' : 'BullMQ connection failed',
      duration,
    };
  } catch (error) {
    return {
      service: 'BullMQ',
      success: false,
      message: 'BullMQ connection failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Run all connection tests
 */
export async function runConnectionTests(): Promise<ConnectionTestResult[]> {
  console.log('🔍 Starting connection tests...\n');

  const results: ConnectionTestResult[] = [];

  // Test Redis
  console.log('Testing Redis connection...');
  const redisResult = await testRedis();
  results.push(redisResult);
  console.log(
    `${redisResult.success ? '✅' : '❌'} ${redisResult.service}: ${redisResult.message}${redisResult.duration ? ` (${redisResult.duration}ms)` : ''}`
  );
  if (redisResult.error) {
    console.log(`   Error: ${redisResult.error}\n`);
  } else {
    console.log();
  }

  // Test BullMQ (only if Redis succeeded)
  if (redisResult.success) {
    console.log('Testing BullMQ connection...');
    const bullmqResult = await testBullMQ();
    results.push(bullmqResult);
    console.log(
      `${bullmqResult.success ? '✅' : '❌'} ${bullmqResult.service}: ${bullmqResult.message}${bullmqResult.duration ? ` (${bullmqResult.duration}ms)` : ''}`
    );
    if (bullmqResult.error) {
      console.log(`   Error: ${bullmqResult.error}\n`);
    } else {
      console.log();
    }
  } else {
    console.log('⏭️  Skipping BullMQ test (Redis connection failed)\n');
    results.push({
      service: 'BullMQ',
      success: false,
      message: 'Skipped - Redis connection failed',
    });
  }

  // Summary
  console.log('📊 Test Summary:');
  const allPassed = results.every(r => r.success);
  results.forEach(result => {
    const status = result.success ? '✅ PASS' : '❌ FAIL';
    console.log(`   ${status} - ${result.service}`);
  });

  console.log(`\n${allPassed ? '✅ All tests passed!' : '❌ Some tests failed'}\n`);

  return results;
}

/**
 * Main execution
 */
async function main() {
  try {
    const results = await runConnectionTests();
    const allPassed = results.every(r => r.success);
    process.exit(allPassed ? 0 : 1);
  } catch (error) {
    console.error('❌ Fatal error during connection tests:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

