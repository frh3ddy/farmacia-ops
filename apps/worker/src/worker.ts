import { runConnectionTests } from './test-connection';
import { WorkerManager } from './worker.manager';

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

  console.log('✅ All connection tests passed.\n');

  // Initialize and start all workers
  const workerManager = new WorkerManager();
  await workerManager.startAll();

  // Graceful shutdown
  const shutdown = async () => {
    await workerManager.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Run worker
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

