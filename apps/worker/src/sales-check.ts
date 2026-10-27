import { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { getSquareClient } from './catalog.sync';

// Sales check (tasks/inventory-integrity-epic.md): every completed Square
// payment must have become a Sale (Sale.squareId is the Square payment id).

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

/** Reads one window of Square payments for every app location, and what the app recorded for them. */
export async function loadSalesCheck(
  prisma: PrismaClient,
  salesQueue: Pick<Queue, 'getFailed'>,
  window: { from: Date; cutoff: Date },
): Promise<SalesCheckInput> {
  const locations = await prisma.location.findMany({ where: { squareId: { not: null } }, select: { id: true, squareId: true } });

  const payments: SquarePayment[] = [];
  for (const location of locations) {
    const page = await getSquareClient().payments.list({
      locationId: location.squareId!,
      beginTime: window.from.toISOString(),
      endTime: window.cutoff.toISOString(),
      sortOrder: 'ASC',
    });
    for await (const payment of page) {
      if (payment.id && payment.status && payment.createdAt) {
        payments.push({ id: payment.id, locationId: location.id, status: payment.status, createdAt: payment.createdAt });
      }
    }
  }

  const recorded = await prisma.sale.findMany({
    where: { squareId: { in: payments.map((p) => p.id) } },
    select: { squareId: true },
  });
  return {
    payments,
    recordedPaymentIds: new Set(recorded.map((s) => s.squareId)),
    failedJobPaymentIds: failedJobPaymentIds(await salesQueue.getFailed()),
    cutoff: window.cutoff,
  };
}

/**
 * Square payment ids of failed sale jobs. BullMQ's getFailed() can return
 * undefined for a failed id whose job data is gone, so those are skipped.
 */
export function failedJobPaymentIds(jobs: Array<{ data?: any } | undefined>): Set<string> {
  return new Set(jobs.map((job) => job?.data?.payload?.object?.payment?.id).filter((id): id is string => !!id));
}
