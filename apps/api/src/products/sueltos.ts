/**
 * Pure sueltos (loose-unit) logic — no DB access. A box product's own
 * stock is displayed in human units via `quantity` (base units per box,
 * see schema.prisma); the actual break-open conversion into a separate
 * loose Product lives in break-bulk.service.ts.
 */

/**
 * Human-readable stock count, e.g. 187 base units with unitsPerBox=20 ->
 * "9 cajas + 7 tabletas". Falls back to a raw count when unitsPerBox is
 * null/0 (nothing to group by).
 */
export function formatStock(totalBaseUnits: number, unitsPerBox: number | null): string {
  if (!unitsPerBox || unitsPerBox <= 0) {
    return `${totalBaseUnits} piezas`;
  }
  const boxes = Math.floor(totalBaseUnits / unitsPerBox);
  const remainder = totalBaseUnits % unitsPerBox;
  if (remainder === 0) return `${boxes} cajas`;
  if (boxes === 0) return `${remainder} tabletas`;
  return `${boxes} cajas + ${remainder} tabletas`;
}
