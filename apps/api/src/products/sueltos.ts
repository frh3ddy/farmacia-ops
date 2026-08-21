/**
 * Pure sueltos (loose-unit) logic — no DB access. A caja product's own
 * stock is displayed in human units via `cantidad` (base units per box,
 * see schema.prisma); the actual break-open conversion into a separate
 * loose Product lives in break-bulk.service.ts.
 */

/**
 * Human-readable stock count, e.g. 187 base units with cantidad=20 ->
 * "9 cajas + 7 tabletas". Falls back to a raw count when cantidad is
 * null/0 (nothing to group by).
 */
export function formatStock(totalBaseUnits: number, cantidad: number | null): string {
  if (!cantidad || cantidad <= 0) {
    return `${totalBaseUnits} piezas`;
  }
  const cajas = Math.floor(totalBaseUnits / cantidad);
  const sueltas = totalBaseUnits % cantidad;
  if (sueltas === 0) return `${cajas} cajas`;
  if (cajas === 0) return `${sueltas} tabletas`;
  return `${cajas} cajas + ${sueltas} tabletas`;
}
