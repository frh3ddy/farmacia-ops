import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Square, SquareClient } from 'square';

export type SquareSyncResult = { synced: boolean; error?: string };

type MappingRef = { squareVariationId: string; locationId: string | null };

/** A real Square item, not a `local_` placeholder (a product or price saved without one). */
export const isSquareMapping = (m: MappingRef) => !m.squareVariationId.startsWith('local_');

/**
 * The mapping a product is read or synced through at a location: the
 * location's, else the global one, else any — Square items are the same at
 * every location — with real Square items before placeholders. Another
 * location's placeholder never counts here.
 */
export function preferredMapping<T extends MappingRef>(mappings: T[], locationId?: string): T | undefined {
  const where = (m: T) => (m.locationId === locationId ? 0 : m.locationId === null ? 1 : 2);
  return mappings
    .filter((m) => isSquareMapping(m) || !locationId || where(m) < 2)
    .map((m) => ({ m, rank: (isSquareMapping(m) ? 0 : 3) + where(m) }))
    .sort((a, b) => a.rank - b.rank)[0]?.m;
}

/** The Square item a product's stock change at a location is sent under; null when it has none. */
export async function findSquareVariationId(
  prisma: Pick<Prisma.TransactionClient, 'catalogMapping'>,
  productId: string,
  locationId: string,
): Promise<string | null> {
  const mappings = await prisma.catalogMapping.findMany({
    where: { productId, NOT: { squareVariationId: { startsWith: 'local_' } } },
    select: { squareVariationId: true, locationId: true },
  });
  return preferredMapping(mappings, locationId)?.squareVariationId ?? null;
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
