// Step-by-step tracing across the worker (sale processing, catalog mapping,
// per-job queue events) runs on every checkout/job — unconditional
// console.log calls add synchronous I/O to hot paths (including inside the
// DB-locked sale transaction), so verbose tracing is opt-in via env var.
// Errors (console.error) are left unconditional — they're rare (exceptional
// paths only) and error visibility in production matters more than the cost.
export const WORKER_DEBUG = process.env.SALE_WORKER_DEBUG === 'true';

export function debugLog(...args: unknown[]): void {
  if (WORKER_DEBUG) {
    console.log(...args);
  }
}
