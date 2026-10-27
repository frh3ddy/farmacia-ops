import { PrismaClient } from '@prisma/client';

// Books check (tasks/inventory-integrity-epic.md): every stock record must add
// up on its own. Comparing a product's total to "opening + movements" can't
// fail for opening stock (its start is only knowable from the batch itself),
// so each record is checked against the movements that touched it.

type Where = { productId: string; locationId: string };

export type Books = {
  /** createdQuantity: what the receiving or adjustment that created the batch added; null for opening stock. */
  batches: Array<Where & { id: string; quantity: number; createdQuantity: number | null }>;
  negativeAdjustments: Array<Where & { id: string; quantity: number }>;
  saleItems: Array<Where & { id: string; quantity: number }>;
  consumedByBatch: Record<string, number>;
  consumedByAdjustment: Record<string, number>;
  consumedBySaleItem: Record<string, number>;
};

export type BooksMismatch = Where & {
  check: 'batch' | 'adjustment' | 'saleItem' | 'openingBatch';
  recordId: string;
  expected: number;
  actual: number;
};

export function booksMismatches(books: Books): BooksMismatch[] {
  const mismatches: BooksMismatch[] = [];
  const report = (check: BooksMismatch['check'], record: Where & { id: string }, expected: number, actual: number) => {
    if (expected !== actual) {
      mismatches.push({ check, recordId: record.id, productId: record.productId, locationId: record.locationId, expected, actual });
    }
  };

  for (const batch of books.batches) {
    if (batch.createdQuantity === null) {
      if (batch.quantity < 0) report('openingBatch', batch, 0, batch.quantity);
    } else {
      report('batch', batch, batch.createdQuantity - (books.consumedByBatch[batch.id] ?? 0), batch.quantity);
    }
  }
  for (const adjustment of books.negativeAdjustments) {
    report('adjustment', adjustment, -adjustment.quantity, books.consumedByAdjustment[adjustment.id] ?? 0);
  }
  for (const item of books.saleItems) {
    report('saleItem', item, item.quantity, books.consumedBySaleItem[item.id] ?? 0);
  }
  return mismatches;
}

/**
 * Reads everything booksMismatches needs in a few set-based queries.
 * ponytail: loads every batch and sale item each night — fine for years of one
 * pharmacy's data (tens of thousands of rows, a few MB); window by date if it grows past that.
 */
export async function loadBooks(prisma: PrismaClient): Promise<Books> {
  const [batches, negativeAdjustments, saleItems, byBatch, byAdjustment, bySaleItem] = await Promise.all([
    prisma.inventory.findMany({
      select: {
        id: true,
        productId: true,
        locationId: true,
        quantity: true,
        createdByReceiving: { select: { quantity: true } },
        // A transfer receipt's batch is created by its TRANSFER_IN adjustment
        // (TransferLine also points at it), so it's counted once, here.
        createdByAdjustment: { select: { quantity: true } },
      },
    }),
    prisma.inventoryAdjustment.findMany({
      where: { quantity: { lt: 0 } },
      select: { id: true, productId: true, locationId: true, quantity: true },
    }),
    prisma.saleItem.findMany({
      select: { id: true, productId: true, quantity: true, sale: { select: { locationId: true } } },
    }),
    prisma.inventoryConsumption.groupBy({ by: ['inventoryId'], _sum: { quantity: true } }),
    prisma.inventoryConsumption.groupBy({ by: ['adjustmentId'], where: { adjustmentId: { not: null } }, _sum: { quantity: true } }),
    prisma.inventoryConsumption.groupBy({ by: ['saleItemId'], where: { saleItemId: { not: null } }, _sum: { quantity: true } }),
  ]);

  const sums = <K extends string>(rows: Array<Record<K, string | null> & { _sum: { quantity: number | null } }>, key: K) =>
    Object.fromEntries(rows.map((row) => [row[key] as string, row._sum.quantity ?? 0]));

  return {
    batches: batches.map((b) => ({
      id: b.id,
      productId: b.productId,
      locationId: b.locationId,
      quantity: b.quantity,
      createdQuantity: b.createdByReceiving?.quantity ?? b.createdByAdjustment?.quantity ?? null,
    })),
    negativeAdjustments,
    saleItems: saleItems.map((i) => ({ id: i.id, productId: i.productId, locationId: i.sale.locationId, quantity: i.quantity })),
    consumedByBatch: sums(byBatch, 'inventoryId'),
    consumedByAdjustment: sums(byAdjustment, 'adjustmentId'),
    consumedBySaleItem: sums(bySaleItem, 'saleItemId'),
  };
}
