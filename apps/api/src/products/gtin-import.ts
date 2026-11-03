/**
 * What the one-time barcode import (scripts/import-gtin-from-square.ts) writes:
 * a product with no barcode gets its Square variations' `upc` when they all
 * agree. Disagreeing ones are left empty for the owner; existing barcodes stay.
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
