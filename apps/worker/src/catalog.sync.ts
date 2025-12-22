import { PrismaClient, Prisma } from '@prisma/client';
import { SquareClient, SquareEnvironment } from 'square';

/**
 * Catalog sync result statistics
 */
export interface CatalogSyncResult {
  totalVariationsFound: number;
  variationsProcessed: number;
  productsCreated: number;
  mappingsCreated: number;
  mappingsSkipped: number;
  errors: CatalogSyncError[];
}

/**
 * Catalog sync error information
 */
export interface CatalogSyncError {
  variationId: string;
  variationName: string;
  error: string;
  skipped: boolean;
}

/**
 * Lazy initialization of Square client (only when needed)
 */
let squareClient: SquareClient | null = null;

function getSquareClient(): SquareClient {
  if (!squareClient) {
    const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();
    
    if (!squareAccessToken) {
      throw new Error('SQUARE_ACCESS_TOKEN environment variable is not set');
    }

    const squareEnvironment =
      (process.env.SQUARE_ENVIRONMENT as SquareEnvironment) ||
      SquareEnvironment.Production;

    squareClient = new SquareClient({
      token: squareAccessToken,
      environment: squareEnvironment,
    });
  }
  return squareClient;
}

/**
 * Sync Square catalog items and create product mappings
 * 
 * Algorithm:
 * 1. Fetch ITEM_VARIATION objects from Square Catalog API
 * 2. For each variation:
 *    a. Check if mapping exists (location-specific if locationId provided, else global)
 *    b. If exists and not forceResync, skip
 *    c. If exists and forceResync, update syncedAt
 *    d. If doesn't exist, create mapping
 *    e. Create product if needed (try SKU lookup first, then create new)
 * 3. Return statistics and errors
 * 
 * @param locationId - Optional location ID (Square location_id string). If provided, creates location-specific mappings
 * @param forceResync - If true, re-syncs existing mappings. Default: false
 * @param prismaClient - Prisma client instance
 * @returns CatalogSyncResult with statistics and errors
 */
export async function syncSquareCatalog(
  locationId: string | null,
  forceResync: boolean,
  prismaClient: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >,
): Promise<CatalogSyncResult> {
  const client = getSquareClient();

  // Fetch catalog objects (ITEM_VARIATION type only)
  let catalogObjects: any[] = [];
  let cursor: string | undefined = undefined;

  try {
    do {
      // Square SDK v40 - use catalog.search method
      const response: any = await client.catalog.search({
        objectTypes: ['ITEM_VARIATION'],
        cursor: cursor,
      });

      if (response.result?.objects) {
        catalogObjects = catalogObjects.concat(response.result.objects);
      }

      cursor = response.result?.cursor || undefined;
    } while (cursor);
  } catch (error) {
    throw new Error(
      `Failed to fetch catalog from Square: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Filter to only ITEM_VARIATION objects (double-check)
  const variations = catalogObjects.filter(
    (obj) => obj.type === 'ITEM_VARIATION',
  );

  const result: CatalogSyncResult = {
    totalVariationsFound: variations.length,
    variationsProcessed: 0,
    productsCreated: 0,
    mappingsCreated: 0,
    mappingsSkipped: 0,
    errors: [],
  };

  // Process each variation
  for (const variation of variations) {
    try {
      const variationId = variation.id;
      const variationData = variation.itemVariationData;
      const variationName = variationData?.name || 'Unknown';
      const variationSku = variationData?.sku || null;

      // Check if mapping already exists
      const existingMapping = await prismaClient.catalogMapping.findFirst({
        where: {
          squareVariationId: variationId,
          locationId: locationId,
        },
      });

      // Skip if mapping exists and not force resync
      if (existingMapping && !forceResync) {
        result.mappingsSkipped++;
        continue;
      }

      // Find or create product
      let product = null;

      // If existing mapping, use the existing product
      if (existingMapping) {
        product = await prismaClient.product.findUnique({
          where: { id: existingMapping.productId },
        });
      }

      // If no product yet and SKU exists, try to find by SKU
      if (!product && variationSku) {
        product = await prismaClient.product.findUnique({
          where: { sku: variationSku },
        });
      }

      // If still no product, create new one
      if (!product) {
        product = await prismaClient.product.create({
          data: {
            name: variationName,
            sku: variationSku, // May be null
          },
        });
        result.productsCreated++;
      }

      // Create or update mapping
      if (existingMapping) {
        // Update existing mapping
        await prismaClient.catalogMapping.update({
          where: { id: existingMapping.id },
          data: {
            syncedAt: new Date(),
            // Update locationId if it changed
            ...(locationId !== null ? { locationId } : {}),
          },
        });
        result.mappingsCreated++; // Count as updated
      } else {
        // Create new mapping
        await prismaClient.catalogMapping.create({
          data: {
            squareVariationId: variationId,
            productId: product.id,
            locationId: locationId, // May be null for global mapping
            syncedAt: new Date(),
          },
        });
        result.mappingsCreated++;
      }

      result.variationsProcessed++;
    } catch (error) {
      // Collect error and continue processing
      const variationId = variation.id || 'unknown';
      const variationName =
        variation.itemVariationData?.name || 'Unknown';
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      result.errors.push({
        variationId,
        variationName,
        error: errorMessage,
        skipped: true,
      });

      // Log error for debugging
      console.error(
        `[CATALOG_SYNC] Error processing variation ${variationId} (${variationName}):`,
        errorMessage,
      );
    }
  }

  return result;
}

