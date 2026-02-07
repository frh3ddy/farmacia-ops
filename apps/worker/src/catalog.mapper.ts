import { PrismaClient, Prisma } from '@prisma/client';
import { UnmappedVariationError, ProductNotFoundError } from './errors';

/**
 * Map a Square variation ID to a Product ID using CatalogMapping table
 * 
 * Algorithm:
 * 1. Convert Square location ID to internal location ID
 * 2. Look up location-specific mapping (squareVariationId + locationId)
 * 3. If not found, look up global mapping (squareVariationId + locationId = null)
 * 4. Validate mapping exists (throw UnmappedVariationError if not)
 * 5. Validate product exists (throw ProductNotFoundError if not)
 * 6. Return productId
 * 
 * @param squareVariationId - ITEM_VARIATION.id from Square
 * @param squareLocationId - Square location_id string (e.g., "LKTAWFNPD1V05")
 * @param prismaClient - Prisma client instance (can be transaction client)
 * @returns Product ID (UUID string)
 * @throws UnmappedVariationError if mapping not found
 * @throws ProductNotFoundError if mapped product doesn't exist
 */
export async function mapVariationToProduct(
  squareVariationId: string,
  squareLocationId: string,
  prismaClient: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >,
): Promise<string> {
  // Step 1: Convert Square location ID to internal location ID
  const location = await prismaClient.location.findUnique({
    where: { squareId: squareLocationId },
    select: { id: true },
  });
  
  const internalLocationId = location?.id || null;
  
  console.log('[DEBUG] [CATALOG_MAPPER] Location lookup:', {
    squareLocationId,
    internalLocationId,
  });

  // Step 2: Try location-specific mapping first (using internal location ID)
  let mapping = internalLocationId
    ? await prismaClient.catalogMapping.findFirst({
        where: {
          squareVariationId: squareVariationId,
          locationId: internalLocationId,
        },
      })
    : null;

  // Step 3: If not found, try global mapping (locationId is null)
  if (!mapping) {
    mapping = await prismaClient.catalogMapping.findFirst({
      where: {
        squareVariationId: squareVariationId,
        locationId: null,
      },
    });
  }

  console.log('[DEBUG] [CATALOG_MAPPER] Mapping lookup result:', {
    squareVariationId,
    internalLocationId,
    mappingFound: !!mapping,
    mappingId: mapping?.id,
  });

  // Step 4: Validate mapping exists
  if (!mapping) {
    throw new UnmappedVariationError(
      squareVariationId,
      squareLocationId,
      'Square variation is not mapped to a product. Please run catalog sync.',
    );
  }

  // Step 5: Validate product exists
  const product = await prismaClient.product.findUnique({
    where: { id: mapping.productId },
  });

  if (!product) {
    throw new ProductNotFoundError(
      mapping.productId,
      mapping.id,
      'Mapped product does not exist in database',
    );
  }

  // Step 6: Return product ID
  return product.id;
}

