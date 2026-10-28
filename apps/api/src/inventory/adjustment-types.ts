import { AdjustmentType } from '@prisma/client';

/**
 * Types a user may record through the adjustments API. The rest are written only
 * by their own flows (transfers, break-bulk, the sale worker), which keep both
 * legs and their links consistent; a hand-made one would create stock the books
 * check can't tell from the real thing.
 */
export const USER_ADJUSTMENT_TYPES: AdjustmentType[] = [
  'DAMAGE',
  'THEFT',
  'EXPIRED',
  'COUNT_CORRECTION',
  'FOUND',
  'RETURN',
  'WRITE_OFF',
  'OTHER',
];

/**
 * Stock that moved, not stock that was lost or found: each leg has a matching
 * leg elsewhere at the same cost, so loss and gain reports leave them out.
 */
export const STOCK_MOVE_TYPES: AdjustmentType[] = ['TRANSFER_OUT', 'TRANSFER_IN', 'BREAK_BULK_OUT', 'BREAK_BULK_IN'];
