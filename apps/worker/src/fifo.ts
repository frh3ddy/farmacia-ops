import { Prisma } from '@prisma/client';

/**
 * Pure FIFO batch-walking logic — no DB access, extracted from
 * calculateFIFOCost so it's directly unit-testable. Batches must already be
 * ordered oldest-first (receivedAt asc) by the caller; this never reorders them.
 */

export interface FifoBatch {
  id: string;
  quantity: number;
  unitCost: Prisma.Decimal | string | number;
}

export interface ConsumedBatch {
  batchId: string;
  quantityConsumed: number;
  costContribution: Prisma.Decimal;
}

export interface FifoConsumptionResult {
  totalCost: Prisma.Decimal;
  consumedBatches: ConsumedBatch[];
  remainingQuantity: number;
}

/**
 * Consume `quantityNeeded` units from `batches` oldest-first, splitting across
 * batches as needed (e.g. a sale spanning two receiving lots at different costs).
 */
export function consumeBatchesFifo(batches: FifoBatch[], quantityNeeded: number): FifoConsumptionResult {
  let remainingQty = quantityNeeded;
  let totalCost = new Prisma.Decimal(0);
  const consumedBatches: ConsumedBatch[] = [];

  for (const batch of batches) {
    if (remainingQty <= 0) break;

    const qtyToConsume = Math.min(batch.quantity, remainingQty);
    const costContribution = new Prisma.Decimal(batch.unitCost).mul(qtyToConsume);

    totalCost = totalCost.add(costContribution);
    consumedBatches.push({ batchId: batch.id, quantityConsumed: qtyToConsume, costContribution });
    remainingQty -= qtyToConsume;
  }

  return { totalCost, consumedBatches, remainingQuantity: Math.max(remainingQty, 0) };
}
