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

/**
 * Left out of shrinkage and the loss/gain report: stock moves, plus the Conteo
 * inicial, which fixes stock the migration loaded wrong rather than losing or finding any.
 */
export const NON_SHRINKAGE_TYPES: AdjustmentType[] = [...STOCK_MOVE_TYPES, 'OPENING_COUNT'];

/**
 * Gains that undo shrinkage: stock written off or miscounted that turned up again.
 * RETURN (customer stock back) and AUTO_SALE_COVER (stock never received in the
 * app) are not recovered losses, so they stay out.
 */
export const SHRINKAGE_RECOVERY_TYPES: AdjustmentType[] = ['FOUND', 'COUNT_CORRECTION'];
