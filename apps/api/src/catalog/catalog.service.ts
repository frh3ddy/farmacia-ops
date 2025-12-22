import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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

@Injectable()
export class CatalogService {
  private squareClient: SquareClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get or create Square client
   */
  private getSquareClient(): SquareClient {
    if (!this.squareClient) {
      const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();

      if (!squareAccessToken) {
        throw new Error('SQUARE_ACCESS_TOKEN environment variable is not set');
      }

      const squareEnvironment =
        (process.env.SQUARE_ENVIRONMENT as SquareEnvironment) ||
        SquareEnvironment.Production;

      this.squareClient = new SquareClient({
        token: squareAccessToken,
        environment: squareEnvironment,
      });
    }
    return this.squareClient;
  }

  /**
   * Sync Square catalog items and create product mappings
   */
  async syncSquareCatalog(
    locationId: string | null,
    forceResync: boolean,
  ): Promise<CatalogSyncResult> {
    const client = this.getSquareClient();

    // Fetch catalog objects (ITEM_VARIATION type only)
    // Square SDK v40 uses pagination iterators - see https://github.com/square/square-nodejs-sdk#pagination
    let catalogObjects: any[] = [];

    try {
      // Use the search method which returns an iterable
      const response = await client.catalog.search({
        objectTypes: ['ITEM_VARIATION'],
      });

      console.log('[CATALOG_SYNC] Square API response type:', typeof response);
      console.log('[CATALOG_SYNC] Is iterable:', Symbol.iterator in (response as any));

      // Square SDK v40 returns an iterable - iterate through all pages
      // See: https://github.com/square/square-nodejs-sdk#pagination
      for await (const item of response as any) {
        console.log('[CATALOG_SYNC] Processing item:', {
          type: item.type,
          id: item.id,
          hasItemVariationData: !!item.itemVariationData,
        });
        
        // Only add ITEM_VARIATION objects
        if (item.type === 'ITEM_VARIATION') {
          catalogObjects.push(item);
        }
      }

      console.log('[CATALOG_SYNC] Total variations collected:', catalogObjects.length);
    } catch (error) {
      console.error('[CATALOG_SYNC] Square API error:', error);
      console.error('[CATALOG_SYNC] Error details:', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
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
        const existingMapping = await this.prisma.catalogMapping.findFirst({
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
          product = await this.prisma.product.findUnique({
            where: { id: existingMapping.productId },
          });
        }

        // If no product yet and SKU exists, try to find by SKU
        if (!product && variationSku) {
          product = await this.prisma.product.findUnique({
            where: { sku: variationSku },
          });
        }

        // If still no product, create new one
        if (!product) {
          product = await this.prisma.product.create({
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
          await this.prisma.catalogMapping.update({
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
          await this.prisma.catalogMapping.create({
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
}

