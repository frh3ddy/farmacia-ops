import { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { getSquareClient } from './square-client';
import { paymentIdOf } from './failed-job';

// Sales check (tasks/inventory-integrity-epic.md): every completed Square
// payment must have become a Sale (Sale.squareId is the Square payment id),
// or a YastasOperation for a Yastás-only payment.

export type SquarePayment = { id: string; locationId: string; status: string; createdAt: string };

export type SalesCheckInput = {
  payments: SquarePayment[];
  recordedPaymentIds: Set<string>;
  /** Payment ids of sale jobs that failed and are kept for replay. */
  failedJobPaymentIds: Set<string>;
  /** Payments after this may still be in the queue. */
  cutoff: Date;
};

export type SalesMismatch = {
  /** lost: no Sale and no failed job — the webhook or queue dropped it. failedJob: replay the kept job. */
  kind: 'lost' | 'failedJob';
  paymentId: string;
  locationId: string;
  createdAt: string;
};

export function salesMismatches({ payments, recordedPaymentIds, failedJobPaymentIds, cutoff }: SalesCheckInput): SalesMismatch[] {
  return payments
    .filter((p) => p.status === 'COMPLETED' && new Date(p.createdAt) <= cutoff && !recordedPaymentIds.has(p.id))
    .map((p) => ({
      kind: failedJobPaymentIds.has(p.id) ? 'failedJob' : 'lost',
      paymentId: p.id,
      locationId: p.locationId,
      createdAt: p.createdAt,
    }));
}

/**
 * Where, and since when, a Square payment must have a sale: sales are recorded
 * only once every location is cut over, so only cut-over locations (a
 * CutoverLock; one with no location covers all) and only from the latest of the
 * window, the location's cutover and `startedAt` (SALES_RECORDING_STARTED_AT).
 * Not started: nothing to check.
 */
export function salesCheckScope(
  locations: Array<{ id: string; squareId: string | null }>,
  locks: Array<{ locationId: string | null; cutoverDate: Date }>,
  startedAt: string | undefined,
  window: { from: Date; cutoff: Date },
): Array<{ locationId: string; squareId: string; from: Date }> {
  if (!startedAt) return [];
  const started = new Date(startedAt);
  if (isNaN(started.getTime())) throw new Error(`SALES_RECORDING_STARTED_AT is not a date: ${startedAt}`);

  return locations.flatMap((location) => {
    const cutovers = locks.filter((l) => l.locationId === location.id || l.locationId === null).map((l) => l.cutoverDate.getTime());
    if (!location.squareId || cutovers.length === 0) return [];
    const from = new Date(Math.max(window.from.getTime(), started.getTime(), ...cutovers));
    return from < window.cutoff ? [{ locationId: location.id, squareId: location.squareId, from }] : [];
  });
}

/** Reads one window of Square payments for the checked locations, and what the app recorded for them. */
export async function loadSalesCheck(
  prisma: PrismaClient,
  salesQueue: Pick<Queue, 'getFailed'>,
  window: { from: Date; cutoff: Date },
): Promise<SalesCheckInput> {
  const scope = salesCheckScope(
    await prisma.location.findMany({ where: { squareId: { not: null } }, select: { id: true, squareId: true } }),
    await prisma.cutoverLock.findMany({ where: { isLocked: true }, select: { locationId: true, cutoverDate: true } }),
    process.env.SALES_RECORDING_STARTED_AT,
    window,
  );

  const payments: SquarePayment[] = [];
  for (const location of scope) {
    const page = await getSquareClient().payments.list({
      locationId: location.squareId,
      beginTime: location.from.toISOString(),
      endTime: window.cutoff.toISOString(),
      sortOrder: 'ASC',
    });
    for await (const payment of page) {
      if (payment.id && payment.status && payment.createdAt) {
        payments.push({ id: payment.id, locationId: location.locationId, status: payment.status, createdAt: payment.createdAt });
      }
    }
  }

  return {
    payments,
    recordedPaymentIds: await recordedPaymentIds(prisma, payments.map((p) => p.id)),
    failedJobPaymentIds: failedJobPaymentIds(await salesQueue.getFailed()),
    cutoff: window.cutoff,
  };
}

/** The payment ids the app recorded: a Sale, or a YastasOperation for a Yastás-only payment (which never creates a Sale). */
export async function recordedPaymentIds(prisma: PrismaClient, paymentIds: string[]): Promise<Set<string>> {
  const query = { where: { squareId: { in: paymentIds } }, select: { squareId: true } } as const;
  const [sales, operations] = await Promise.all([prisma.sale.findMany(query), prisma.yastasOperation.findMany(query)]);
  return new Set([...sales, ...operations].map((r) => r.squareId).filter((id): id is string => !!id));
}

/**
 * Square payment ids of failed sale jobs. BullMQ's getFailed() can return
 * undefined for a failed id whose job data is gone, so those are skipped.
 */
export function failedJobPaymentIds(jobs: Array<{ data?: any } | undefined>): Set<string> {
  return new Set(jobs.map(paymentIdOf).filter((id): id is string => !!id));
}
