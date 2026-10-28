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
