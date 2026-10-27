import { config } from 'dotenv';
import { resolve } from 'path';
import { runConnectionTests } from './test-connection';
import { WorkerManager } from './worker.manager';
import { debugLog } from './debug-log';

// Load .env file from project root (for local development)
// In Railway, environment variables are automatically available via process.env
// This is just a fallback for local development
const envPath = resolve(__dirname, '../../../.env');
config({ path: envPath });

/**
 * Main worker entry point
 */
async function main() {
  debugLog('[DEBUG] [WORKER_MAIN] ========================================');
  debugLog('[DEBUG] [WORKER_MAIN] 🚀 Starting Farmacia Ops Worker...\n');
  debugLog('[DEBUG] [WORKER_MAIN] Node version:', process.version);
  debugLog('[DEBUG] [WORKER_MAIN] Process PID:', process.pid);
  debugLog('[DEBUG] [WORKER_MAIN] Environment:', process.env.NODE_ENV || 'development');
  
  console.log('[WORKER_MAIN] SQUARE_ACCESS_TOKEN set:', !!process.env.SQUARE_ACCESS_TOKEN, '· SQUARE_ENVIRONMENT:', process.env.SQUARE_ENVIRONMENT || 'not set');

  // Run connection tests on startup
  debugLog('[DEBUG] [WORKER_MAIN] Running connection tests...\n');
  const testResults = await runConnectionTests();
  debugLog('[DEBUG] [WORKER_MAIN] Connection test results:', testResults.map(r => ({
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

  debugLog('[DEBUG] [WORKER_MAIN] ✅ All connection tests passed.\n');

  // Initialize and start all workers
  debugLog('[DEBUG] [WORKER_MAIN] Initializing WorkerManager...');
  const workerManager = new WorkerManager();
  debugLog('[DEBUG] [WORKER_MAIN] Starting all workers...');
  await workerManager.startAll();
  console.log('[WORKER_MAIN] Workers started');
  debugLog('[DEBUG] [WORKER_MAIN] ========================================\n');

  // Graceful shutdown
  const shutdown = async () => {
    debugLog('[DEBUG] [WORKER_MAIN] Shutdown signal received');
    await workerManager.shutdown();
    debugLog('[DEBUG] [WORKER_MAIN] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  debugLog('[DEBUG] [WORKER_MAIN] Shutdown handlers registered');
}

// Run worker
main().catch((error) => {
  console.error('[DEBUG] [WORKER_MAIN] ❌ Fatal error in main():', error);
  console.error('[DEBUG] [WORKER_MAIN] Error message:', error instanceof Error ? error.message : String(error));
  console.error('[DEBUG] [WORKER_MAIN] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
  process.exit(1);
});

