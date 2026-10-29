import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Square, SquareClient } from 'square';

export type SquareSyncResult = { synced: boolean; error?: string };

/**
 * The Square item a product's stock change at a location is sent under: the
 * location's mapping, else the global one, else any — Square items are the
 * same at every location. Never a `local_` placeholder (a product or price
 * saved without a Square item); null when only those exist.
 */
export async function findSquareVariationId(
  prisma: Pick<Prisma.TransactionClient, 'catalogMapping'>,
  productId: string,
  locationId: string,
): Promise<string | null> {
  const mappings = await prisma.catalogMapping.findMany({
    where: { productId, NOT: { squareVariationId: { startsWith: 'local_' } } },
    select: { squareVariationId: true, locationId: true },
  });
  const preferred = mappings.find((m) => m.locationId === locationId)
    ?? mappings.find((m) => m.locationId === null)
    ?? mappings[0];
  return preferred?.squareVariationId ?? null;
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
