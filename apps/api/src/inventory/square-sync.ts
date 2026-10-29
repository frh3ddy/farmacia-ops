import { Logger } from '@nestjs/common';
import { Square, SquareClient, SquareEnvironment } from 'square';

export type SquareSyncResult = { synced: boolean; error?: string };

/**
 * The Square client inventory pushes go through, or null (sync disabled)
 * without SQUARE_ACCESS_TOKEN. NODE_ENV=development always means sandbox, even
 * with SQUARE_ENVIRONMENT=production, so a dev machine can't move real stock.
 */
export function createSquareClient(logger: Logger): SquareClient | null {
  const token = process.env.SQUARE_ACCESS_TOKEN?.trim();
  if (!token) {
    logger.warn('SQUARE_ACCESS_TOKEN not set - Square sync disabled');
    return null;
  }
  const isSandbox =
    process.env.SQUARE_ENVIRONMENT?.toLowerCase() === 'sandbox' || process.env.NODE_ENV?.toLowerCase() === 'development';
  return new SquareClient({
    token,
    environment: isSandbox ? SquareEnvironment.Sandbox : SquareEnvironment.Production,
    version: '2026-09-16', // pinned so an SDK bump can't silently change behavior
  });
}

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
