/**
 * Pure break-bulk math — no DB access. Breaking open `boxQuantity` boxes
 * (each `unitsPerBox` base units) must preserve total cost basis exactly: the
 * $ value removed from the box product's inventory equals the $ value added
 * to the loose product's, so a break-bulk action itself never creates or
 * destroys COGS/valuation — only an eventual sale does.
 */

export function looseUnitsFromBoxes(boxQuantity: number, unitsPerBox: number): number {
  return boxQuantity * unitsPerBox;
}

/**
 * Cost per loose unit, derived from the *actual* total cost removed from the
 * box product (already FIFO-weighted across whatever lots were consumed) —
 * not re-derived from a single lot's unit cost, so cross-lot break-bulk
 * consumption still preserves the exact cost basis.
 */
export function costPerLooseUnit(totalBoxCostRemoved: number, looseUnits: number): number {
  if (looseUnits <= 0) return 0;
  return totalBoxCostRemoved / looseUnits;
}
