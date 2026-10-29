import { Logger } from '@nestjs/common';
import { Square, SquareClient } from 'square';

export type SquareSyncResult = { synced: boolean; error?: string };

/** Sends the changes; Square's rejection comes back as { synced: false, error }. Thrown errors are the caller's. */
export async function sendInventoryChanges(
  client: SquareClient,
  request: Square.BatchChangeInventoryRequest,
  logger: Logger,
  label: string,
): Promise<SquareSyncResult> {
  const response = await client.inventory.batchCreateChanges(request);
  if (response.errors && response.errors.length > 0) {
    const errorMessage = response.errors.map((e) => e.detail || e.code).join('; ');
    logger.error(`[SQUARE_SYNC] Square rejected ${label}: ${errorMessage}`);
    return { synced: false, error: errorMessage };
  }
  logger.log(`[SQUARE_SYNC] Successfully synced ${label} to Square. Response counts: ${JSON.stringify(response.counts || 'no counts')}`);
  return { synced: true };
}
