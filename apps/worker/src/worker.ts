import { runConnectionTests } from './test-connection';
import { WorkerManager } from './worker.manager';

/**
 * Main worker entry point
 */
async function main() {
  console.log('[DEBUG] [WORKER_MAIN] ========================================');
  console.log('[DEBUG] [WORKER_MAIN] 🚀 Starting Farmacia Ops Worker...\n');
  console.log('[DEBUG] [WORKER_MAIN] Node version:', process.version);
  console.log('[DEBUG] [WORKER_MAIN] Process PID:', process.pid);
  console.log('[DEBUG] [WORKER_MAIN] Environment:', process.env.NODE_ENV || 'development');

  // Run connection tests on startup
  console.log('[DEBUG] [WORKER_MAIN] Running connection tests...\n');
  const testResults = await runConnectionTests();
  console.log('[DEBUG] [WORKER_MAIN] Connection test results:', testResults.map(r => ({
    service: r.service,
    success: r.success,
    message: r.message,
  })));

  const allTestsPassed = testResults.every(r => r.success);
  if (!allTestsPassed) {
    console.error('[DEBUG] [WORKER_MAIN] ❌ Connection tests failed. Worker cannot start.');
    const failedTests = testResults.filter(r => !r.success);
    console.error('[DEBUG] [WORKER_MAIN] Failed tests:', failedTests);
    process.exit(1);
  }

  console.log('[DEBUG] [WORKER_MAIN] ✅ All connection tests passed.\n');

  // Initialize and start all workers
  console.log('[DEBUG] [WORKER_MAIN] Initializing WorkerManager...');
  const workerManager = new WorkerManager();
  console.log('[DEBUG] [WORKER_MAIN] Starting all workers...');
  await workerManager.startAll();
  console.log('[DEBUG] [WORKER_MAIN] All workers started successfully');
  console.log('[DEBUG] [WORKER_MAIN] ========================================\n');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[DEBUG] [WORKER_MAIN] Shutdown signal received');
    await workerManager.shutdown();
    console.log('[DEBUG] [WORKER_MAIN] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  console.log('[DEBUG] [WORKER_MAIN] Shutdown handlers registered');
}

// Run worker
main().catch((error) => {
  console.error('[DEBUG] [WORKER_MAIN] ❌ Fatal error in main():', error);
  console.error('[DEBUG] [WORKER_MAIN] Error message:', error instanceof Error ? error.message : String(error));
  console.error('[DEBUG] [WORKER_MAIN] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
  process.exit(1);
});

