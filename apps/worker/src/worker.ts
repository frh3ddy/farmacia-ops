import { runConnectionTests } from './test-connection';
import { createWorker, createQueue } from '@farmacia-ops/shared';
import { Job } from 'bullmq';

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

