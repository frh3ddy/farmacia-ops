import { Prisma, PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { booksMismatches, loadBooks } from './books-check';
import { fifoViolations, loadFifoCheck } from './fifo-check';
import { loadSalesCheck, salesMismatches } from './sales-check';

// Nightly integrity job (tasks/inventory-integrity-epic.md): runs the three
// checks, stores the result for the web banner and logs it. Read-only — it
// never corrects stock or sales. A failed check (e.g. Square down) is recorded
// as failed and retried by the next night's run, not in a loop.

const HOUR_MS = 3_600_000;
const RETENTION_DAYS = 90;

type CheckResult = { status: 'ok'; mismatches: unknown[] } | { status: 'failed'; error: string; mismatches: [] };

export type IntegrityRunRecord = {
  ranAt: Date;
  mismatchCount: number;
  checks: { books: CheckResult; sales: CheckResult; fifo: CheckResult };
};

export type IntegrityDeps = {
  books: () => Promise<unknown[]>;
  sales: (window: { from: Date; cutoff: Date }) => Promise<unknown[]>;
  fifo: (window: { from: Date; to: Date }) => Promise<unknown[]>;
  save: (run: IntegrityRunRecord) => Promise<void>;
  log: (line: string) => void;
};

async function attempt(check: () => Promise<unknown[]>): Promise<CheckResult> {
  try {
    return { status: 'ok', mismatches: await check() };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error), mismatches: [] };
  }
}

export async function runIntegrityChecks(deps: IntegrityDeps, now = new Date()): Promise<IntegrityRunRecord> {
  // 48 h back so a payment taken offline (synced to Square late) is still seen;
  // sales stop 30 min before the run since newer ones may still be in the queue.
  const from = new Date(now.getTime() - 48 * HOUR_MS);
  const checks = {
    books: await attempt(deps.books),
    sales: await attempt(() => deps.sales({ from, cutoff: new Date(now.getTime() - 0.5 * HOUR_MS) })),
    fifo: await attempt(() => deps.fifo({ from, to: now })),
  };
  const run = { ranAt: now, mismatchCount: Object.values(checks).reduce((n, c) => n + c.mismatches.length, 0), checks };

  await deps.save(run);
  const summary = (Object.entries(checks) as Array<[string, CheckResult]>).map(([name, c]) =>
    c.status === 'ok' ? `${name} ok (${c.mismatches.length})` : `${name} failed (${c.error})`,
  );
  deps.log(`[INTEGRITY] ${summary.join(' · ')}`);
  for (const [name, c] of Object.entries(checks)) {
    for (const mismatch of c.mismatches) deps.log(`[INTEGRITY] ${name} ${JSON.stringify(mismatch)}`);
  }
  return run;
}

/** The real checks and storage, for the worker's `integrity` queue. */
export function integrityDeps(prisma: PrismaClient, salesQueue: Pick<Queue, 'getFailed'>): IntegrityDeps {
  return {
    books: async () => booksMismatches(await loadBooks(prisma)),
    sales: async (window) => salesMismatches(await loadSalesCheck(prisma, salesQueue, window)),
    fifo: async (window) => fifoViolations(await loadFifoCheck(prisma, window)),
    save: async (run) => {
      await prisma.integrityRun.create({
        data: {
          ranAt: run.ranAt,
          mismatchCount: run.mismatchCount,
          // Mismatches hold only strings and numbers, so they are valid JSON.
          checks: run.checks as unknown as Prisma.InputJsonValue,
        },
      });
      await prisma.integrityRun.deleteMany({ where: { ranAt: { lt: new Date(run.ranAt.getTime() - RETENTION_DAYS * 24 * HOUR_MS) } } });
    },
    log: (line) => console.log(line),
  };
}
