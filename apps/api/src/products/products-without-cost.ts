/**
 * Products that came in from Square (catalog sync) after the cutover and so
 * never got a cost: a real Square mapping, but not a single Inventory batch
 * anywhere. Backs GET /products/without-cost, where a cost is entered and
 * Square's on-hand count is recorded as a FOUND batch (syncToSquare: false).
 * Pure SQL so it runs against PGlite in products-without-cost.pg.spec.ts.
 *
 * ponytail: "no batches at any location" — a product stocked at one location
 * but missing at another is not listed; add per-location detection if needed.
 */
import { Prisma } from '@prisma/client';

export interface ProductWithoutCost {
  id: string;
  name: string;
  sku: string | null;
  squareImageUrl: string | null;
  squareDataSyncedAt: Date | null;
}

export const productsWithoutCostSql = Prisma.sql`
  SELECT p.id, p.name, p.sku, p."squareImageUrl", p."squareDataSyncedAt"
  FROM "Product" p
  WHERE p."tracksInventory" = true
    AND p."isDiscontinued" = false
    AND EXISTS (
      SELECT 1 FROM "CatalogMapping" m
      WHERE m."productId" = p.id AND m."squareVariationId" NOT LIKE 'local_%'
    )
    AND NOT EXISTS (SELECT 1 FROM "Inventory" i WHERE i."productId" = p.id)
  ORDER BY p."squareDataSyncedAt" DESC NULLS LAST, p.name
`;
