/**
 * Pure break-bulk math — no DB access. Breaking open `cajaQuantity` cajas
 * (each `cantidad` base units) must preserve total cost basis exactly: the
 * $ value removed from the caja product's inventory equals the $ value added
 * to the loose product's, so a break-bulk action itself never creates or
 * destroys COGS/valuation — only an eventual sale does.
 */

export function looseUnitsFromCajas(cajaQuantity: number, cantidad: number): number {
  return cajaQuantity * cantidad;
}

/**
 * Cost per loose unit, derived from the *actual* total cost removed from the
 * caja product (already FIFO-weighted across whatever lots were consumed) —
 * not re-derived from a single lot's unit cost, so cross-lot break-bulk
 * consumption still preserves the exact cost basis.
 */
export function costPerLooseUnit(totalCajaCostRemoved: number, looseUnits: number): number {
  if (looseUnits <= 0) return 0;
  return totalCajaCostRemoved / looseUnits;
}
