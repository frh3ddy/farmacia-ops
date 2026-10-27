import { Prisma } from '@prisma/client';
import { SaleValidationError } from './errors';
import type { MappedProduct } from './catalog.mapper';

/** The fields of a Square order line item the sale needs. */
export type OrderLine = {
  uid?: string | null;
  name?: string | null;
  note?: string | null;
  catalogObjectId?: string | null;
  quantity?: string | null;
  totalMoney?: { amount?: bigint | number | null; currency?: string | null } | null;
};

export type SaleLines = {
  saleItems: Array<{ productId: string; quantitySold: number; salePrice: Prisma.Decimal }>;
  /** Yastás service items: never a Sale or SaleItem, never FIFO (vision.md). */
  yastasLines: Array<{ employeeId: string; faceAmount: Prisma.Decimal; lineUid: string | null }>;
  /** Custom amounts (no catalog item): counted in revenue, cost pending until matched to a product. */
  customLines: Array<{ description: string | null; quantity: number; amount: Prisma.Decimal; lineUid: string | null }>;
};

const safeStringify = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

/**
 * Splits a Square order's lines into sale items, Yastás lines and custom amounts.
 * `mappings` holds the resolved product for every catalogObjectId in `lines`.
 */
export function toSaleLines(
  lines: OrderLine[],
  mappings: Map<string, MappedProduct>,
  context: { orderId: string; squareId: string; locationId: string },
): SaleLines {
  const result: SaleLines = { saleItems: [], yastasLines: [], customLines: [] };

  for (const line of lines) {
    const quantity = line.quantity ? parseInt(line.quantity, 10) : 1;
    if (!(quantity > 0)) {
      throw new SaleValidationError('Line item quantity must be positive', { orderLineItem: safeStringify(line) });
    }

    const amount = line.totalMoney?.amount;
    if (amount === undefined || amount === null) {
      throw new SaleValidationError('Line item missing price information', { orderLineItem: safeStringify(line) });
    }
    // Square money is in centavos; the line total covers its whole quantity.
    const total = new Prisma.Decimal(amount.toString()).div(100);
    if (total.lt(0)) {
      throw new SaleValidationError('Line item salePrice must be non-negative', { orderLineItem: safeStringify(line) });
    }

    const mapped = line.catalogObjectId ? mappings.get(line.catalogObjectId) : undefined;
    if (!mapped) {
      result.customLines.push({ description: line.name || line.note || null, quantity, amount: total, lineUid: line.uid ?? null });
      continue;
    }

    if (!mapped.tracksInventory) {
      if (!mapped.employeeId) {
        throw new SaleValidationError(
          `CatalogMapping for variation ${line.catalogObjectId} is flagged non-inventory (tracksInventory=false) but has no employeeId`,
          { catalogObjectId: line.catalogObjectId, ...context },
        );
      }
      result.yastasLines.push({ employeeId: mapped.employeeId, faceAmount: total, lineUid: line.uid ?? null });
      continue;
    }

    result.saleItems.push({ productId: mapped.productId, quantitySold: quantity, salePrice: total.div(quantity) });
  }

  return result;
}
