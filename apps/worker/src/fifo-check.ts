import { PrismaClient } from '@prisma/client';

// FIFO check (tasks/inventory-integrity-epic.md). Consumption rows don't record
// the order they were taken in, but batch quantities only ever go down: an
// older batch with stock now had at least that much when the sale ran, so a
// sale that took a newer batch skipped it.

type Where = { productId: string; locationId: string };

export type FifoCheckInput = {
  saleItems: Array<Where & { id: string; consumedAt: Date; consumedBatchIds: string[] }>;
  /** The consumed batches, plus every batch with stock for the same products. */
  batches: Array<Where & { id: string; quantity: number; receivedAt: Date; createdAt: Date }>;
};

export type FifoViolation = Where & { saleItemId: string; consumedBatchId: string; skippedBatchId: string };

export function fifoViolations({ saleItems, batches }: FifoCheckInput): FifoViolation[] {
  const byId = new Map(batches.map((b) => [b.id, b]));
  const violations: FifoViolation[] = [];

  for (const item of saleItems) {
    const consumed = item.consumedBatchIds.map((id) => byId.get(id)).filter((b) => b !== undefined);
    if (consumed.length === 0) continue;
    const newest = consumed.reduce((a, b) => (b.receivedAt > a.receivedAt ? b : a));

    // createdAt ≤ consumedAt: cutover and transfer batches carry an old
    // receivedAt but were created later, so they didn't exist at the sale.
    const skipped = batches
      .filter(
        (b) =>
          b.productId === item.productId &&
          b.locationId === item.locationId &&
          b.quantity > 0 &&
          b.receivedAt < newest.receivedAt &&
          b.createdAt <= item.consumedAt,
      )
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())[0];

    if (skipped) {
      violations.push({ saleItemId: item.id, productId: item.productId, locationId: item.locationId, consumedBatchId: newest.id, skippedBatchId: skipped.id });
    }
  }
  return violations;
}

/** Reads the sale consumptions in a window and the batches needed to judge them, in two queries. */
export async function loadFifoCheck(prisma: PrismaClient, window: { from: Date; to: Date }): Promise<FifoCheckInput> {
  const consumptions = await prisma.inventoryConsumption.findMany({
    where: { saleItemId: { not: null }, consumedAt: { gte: window.from, lte: window.to } },
    select: { saleItemId: true, inventoryId: true, consumedAt: true, inventory: { select: { productId: true, locationId: true } } },
  });

  const saleItems = new Map<string, FifoCheckInput['saleItems'][number]>();
  for (const c of consumptions) {
    const item = saleItems.get(c.saleItemId!) ?? {
      id: c.saleItemId!,
      productId: c.inventory.productId,
      locationId: c.inventory.locationId,
      consumedAt: c.consumedAt,
      consumedBatchIds: [],
    };
    item.consumedBatchIds.push(c.inventoryId);
    saleItems.set(item.id, item);
  }

  const batches = await prisma.inventory.findMany({
    where: {
      OR: [
        { id: { in: consumptions.map((c) => c.inventoryId) } },
        { productId: { in: [...new Set(consumptions.map((c) => c.inventory.productId))] }, quantity: { gt: 0 } },
      ],
    },
    select: { id: true, productId: true, locationId: true, quantity: true, receivedAt: true, createdAt: true },
  });

  return { saleItems: [...saleItems.values()], batches };
}
