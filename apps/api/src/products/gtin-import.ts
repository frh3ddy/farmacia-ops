import type { PrismaClient } from '@prisma/client';
import type { SquareClient } from 'square';
import { isSquareMapping } from '../inventory/square-sync';

/**
 * What the one-time barcode import writes: a product with no barcode gets its
 * Square variations' `upc` when they all agree. Disagreeing ones are left
 * empty for the owner; existing barcodes stay.
 */
export function planGtinImport(
  products: { id: string; gtin: string | null; variationIds: string[] }[],
  upcByVariation: Map<string, string>,
) {
  const updates: { productId: string; gtin: string }[] = [];
  const conflicts: { productId: string; upcs: string[] }[] = [];
  for (const product of products) {
    if (product.gtin) continue;
    const found = [...new Set(product.variationIds.map((v) => upcByVariation.get(v)?.trim()).filter((u): u is string => !!u))].sort();
    if (found.length === 1) updates.push({ productId: product.id, gtin: found[0] });
    else if (found.length > 1) conflicts.push({ productId: product.id, upcs: found });
  }
  return { updates, conflicts };
}

/**
 * The one-time barcode import (catalog sync is migration-only): reads every
 * mapped Square variation's `upc` — only reads Square, never writes to it —
 * and, with `save`, fills Product.gtin per planGtinImport.
 */
export async function importGtinFromSquare(
  prisma: Pick<PrismaClient, 'product' | '$executeRaw'>,
  client: Pick<SquareClient, 'catalog'>,
  { save }: { save: boolean },
) {
  const rows = await prisma.product.findMany({
    select: { id: true, name: true, gtin: true, catalogMappings: { select: { squareVariationId: true, locationId: true } } },
  });
  const products = rows.map((p) => ({
    id: p.id,
    gtin: p.gtin,
    variationIds: p.catalogMappings.filter(isSquareMapping).map((m) => m.squareVariationId),
  }));

  const variationIds = [...new Set(products.flatMap((p) => p.variationIds))];
  const upcByVariation = new Map<string, string>();
  for (let i = 0; i < variationIds.length; i += 1000) {
    const { objects = [] } = await client.catalog.batchGet({ objectIds: variationIds.slice(i, i + 1000) });
    for (const o of objects) {
      if (o.type === 'ITEM_VARIATION' && o.id && o.itemVariationData?.upc) upcByVariation.set(o.id, o.itemVariationData.upc);
    }
  }

  const { updates, conflicts } = planGtinImport(products, upcByVariation);
  // One statement, so all or nothing with no transaction to expire (500
  // updates in one ran past Prisma's 5 s limit in production). "gtin" IS NULL
  // again, so a barcode set in the app since the read is never overwritten.
  const saved =
    save && updates.length
      ? await prisma.$executeRaw`
          UPDATE "Product" SET "gtin" = u.gtin
          FROM unnest(${updates.map((u) => u.productId)}::text[], ${updates.map((u) => u.gtin)}::text[]) AS u(id, gtin)
          WHERE "Product"."id" = u.id AND "Product"."gtin" IS NULL`
      : 0;

  const nameOf = new Map(rows.map((p) => [p.id, p.name]));
  return {
    products: rows.length,
    alreadyHadBarcode: rows.filter((p) => p.gtin).length,
    variationsRead: variationIds.length,
    variationsWithBarcode: upcByVariation.size,
    toSave: updates.length,
    saved,
    conflicts: conflicts.map((c) => ({ productId: c.productId, name: nameOf.get(c.productId)!, upcs: c.upcs })),
  };
}
