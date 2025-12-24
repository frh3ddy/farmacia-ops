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

      // Determine Square environment: use Sandbox for staging/dev, Production otherwise
      let squareEnvironment: SquareEnvironment;
      const nodeEnv = process.env.NODE_ENV?.toLowerCase();
      const railwayEnv = process.env.RAILWAY_ENVIRONMENT?.toLowerCase();
      const squareEnv = process.env.SQUARE_ENVIRONMENT?.toLowerCase();

      if (
        squareEnv === 'sandbox' ||
        nodeEnv === 'development' ||
        nodeEnv === 'dev' ||
        railwayEnv === 'staging' ||
        railwayEnv === 'development'
      ) {
        squareEnvironment = SquareEnvironment.Sandbox;
      } else if (squareEnv === 'production') {
        squareEnvironment = SquareEnvironment.Production;
      } else {
        // Default to Production for safety
        squareEnvironment = SquareEnvironment.Production;
      }

      this.squareClient = new SquareClient({
        token: squareAccessToken,
        environment: squareEnvironment,
      });
    }
    return this.squareClient;
  }

  /**
   * Fetch multiple catalog objects in batch from Square
   * This is much more efficient than fetching one at a time
   */
  private async fetchBatchCatalogObjects(
    variationIds: string[],
  ): Promise<Map<string, { productName: string | null; productDescription: string | null; imageUrl: string | null }>> {
    const client = this.getSquareClient();
    const resultMap = new Map<string, { productName: string | null; productDescription: string | null; imageUrl: string | null }>();

    // Square API has a limit on batch size, typically 100 objects
    const BATCH_SIZE = 100;
    
    for (let i = 0; i < variationIds.length; i += BATCH_SIZE) {
      const batch = variationIds.slice(i, i + BATCH_SIZE);
      
      try {
        const response = await client.catalog.batchGet({
          objectIds: batch,
          includeRelatedObjects: true,
        });

        let objects: any[] = [];
        let relatedObjects: any[] = [];

        if ((response as any).objects) {
          objects = (response as any).objects;
          relatedObjects = (response as any).relatedObjects || [];
        } else if ((response as any).object) {
          objects = [(response as any).object];
          relatedObjects = (response as any).relatedObjects || (response as any).related_objects || [];
        } else {
          objects = (response as any).data || [];
          relatedObjects = (response as any).relatedObjects || (response as any).related_objects || [];
        }

        // Process each object in the batch
        for (const obj of objects) {
          if (obj.type !== 'ITEM_VARIATION') {
            resultMap.set(obj.id, { productName: null, productDescription: null, imageUrl: null });
            continue;
          }

          let productName: string | null = null;
          let productDescription: string | null = null;
          let imageUrl: string | null = null;

          const itemObject = relatedObjects.find(
            (related: any) => related.type === 'ITEM' && (related.itemData || related.item_data),
          );

          const itemData = itemObject?.itemData || itemObject?.item_data;

          if (itemData) {
            productName = itemData.name || null;
            productDescription =
              itemData.descriptionPlaintext ||
              itemData.description_plaintext ||
              itemData.description ||
              null;

            const imageIds = itemData.imageIds || itemData.image_ids || [];

            if (imageIds && imageIds.length > 0) {
              const imageObject = relatedObjects.find(
                (related: any) => {
                  if (related.type !== 'IMAGE') return false;
                  const relatedId = related.id || related.Id || related.ID;
                  return imageIds.some((imgId: string) => imgId === relatedId);
                },
              );

              if (imageObject) {
                const imageData = imageObject.imageData || imageObject.image_data;
                if (imageData) {
                  imageUrl = imageData.url || null;
                }
              } else {
                // Fetch image explicitly if not in related_objects (only for first image)
                try {
                  const imageResponse = await client.catalog.batchGet({
                    objectIds: [imageIds[0]],
                    includeRelatedObjects: false,
                  });

                  let imageObjects: any[] = [];
                  if ((imageResponse as any).objects) {
                    imageObjects = (imageResponse as any).objects;
                  } else if ((imageResponse as any).object) {
                    imageObjects = [(imageResponse as any).object];
                  } else {
                    imageObjects = (imageResponse as any).data || [];
                  }

                  if (imageObjects.length > 0 && imageObjects[0].type === 'IMAGE') {
                    const imageData =
                      imageObjects[0].imageData || imageObjects[0].image_data;
                    if (imageData && imageData.url) {
                      imageUrl = imageData.url;
                    }
                  }
                } catch (imageError) {
                  console.warn(
                    `[CATALOG_SYNC] Failed to fetch image ${imageIds[0]} for variation ${obj.id}:`,
                    imageError,
                  );
                }
              }
            }
          }

          resultMap.set(obj.id, { productName, productDescription, imageUrl });
        }
      } catch (error) {
        console.warn(
          `[CATALOG_SYNC] Failed to fetch batch for variations ${batch.join(', ')}:`,
          error,
        );
        // Set null values for failed variations
        for (const id of batch) {
          if (!resultMap.has(id)) {
            resultMap.set(id, { productName: null, productDescription: null, imageUrl: null });
          }
        }
      }
    }

    return resultMap;
  }

  /**
   * Fetch full catalog object with related objects (ITEM, IMAGE) from Square
   * This is used to get product name, description, and image URL
   * @deprecated Use fetchBatchCatalogObjects for better performance
   */
  private async fetchFullCatalogObject(
    variationId: string,
  ): Promise<{
    productName: string | null;
    productDescription: string | null;
    imageUrl: string | null;
  }> {
    const client = this.getSquareClient();

    try {
      const response = await client.catalog.batchGet({
        objectIds: [variationId],
        includeRelatedObjects: true,
      });

      let objects: any[] = [];
      let relatedObjects: any[] = [];

      if ((response as any).objects) {
        objects = (response as any).objects;
        relatedObjects = (response as any).relatedObjects || [];
      } else if ((response as any).object) {
        objects = [(response as any).object];
        relatedObjects = (response as any).relatedObjects || (response as any).related_objects || [];
      } else {
        objects = (response as any).data || [];
        relatedObjects = (response as any).relatedObjects || (response as any).related_objects || [];
      }

      if (objects.length === 0) {
        return { productName: null, productDescription: null, imageUrl: null };
      }

      const obj = objects[0];
      if (obj.type !== 'ITEM_VARIATION') {
        return { productName: null, productDescription: null, imageUrl: null };
      }

      let productName: string | null = null;
      let productDescription: string | null = null;
      let imageUrl: string | null = null;

      const itemObject = relatedObjects.find(
        (related: any) => related.type === 'ITEM' && (related.itemData || related.item_data),
      );

      const itemData = itemObject?.itemData || itemObject?.item_data;

      if (itemData) {
        productName = itemData.name || null;
        productDescription =
          itemData.descriptionPlaintext ||
          itemData.description_plaintext ||
          itemData.description ||
          null;

        const imageIds = itemData.imageIds || itemData.image_ids || [];

        if (imageIds && imageIds.length > 0) {
          const imageObject = relatedObjects.find(
            (related: any) => {
              if (related.type !== 'IMAGE') return false;
              const relatedId = related.id || related.Id || related.ID;
              return imageIds.some((imgId: string) => imgId === relatedId);
            },
          );

          if (imageObject) {
            const imageData = imageObject.imageData || imageObject.image_data;
            if (imageData) {
              imageUrl = imageData.url || null;
            }
          } else {
            // Fetch image explicitly if not in related_objects
            try {
              const imageResponse = await client.catalog.batchGet({
                objectIds: [imageIds[0]],
                includeRelatedObjects: false,
              });

              let imageObjects: any[] = [];
              if ((imageResponse as any).objects) {
                imageObjects = (imageResponse as any).objects;
              } else if ((imageResponse as any).object) {
                imageObjects = [(imageResponse as any).object];
              } else {
                imageObjects = (imageResponse as any).data || [];
              }

              if (imageObjects.length > 0 && imageObjects[0].type === 'IMAGE') {
                const imageData =
                  imageObjects[0].imageData || imageObjects[0].image_data;
                if (imageData && imageData.url) {
                  imageUrl = imageData.url;
                }
              }
            } catch (imageError) {
              console.warn(
                `[CATALOG_SYNC] Failed to fetch image ${imageIds[0]} for variation ${variationId}:`,
                imageError,
              );
            }
          }
        }
      }

      return { productName, productDescription, imageUrl };
    } catch (error) {
      console.warn(
        `[CATALOG_SYNC] Failed to fetch full catalog object for ${variationId}:`,
        error,
      );
      return { productName: null, productDescription: null, imageUrl: null };
    }
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
    // Square SDK v40 - handle pagination manually with cursor
    let catalogObjects: any[] = [];
    let cursor: string | undefined = undefined;

    try {
      do {
        // Square SDK v40 - catalog.search returns a response object, not an iterable
        const response = await client.catalog.search({
          objectTypes: ['ITEM_VARIATION'],
          cursor: cursor,
        });

        // Square SDK v40 response structure: response.objects (array)
        if (response.objects && Array.isArray(response.objects)) {
          for (const item of response.objects) {
            // Only add ITEM_VARIATION objects (should all be, but double-check)
            if (item.type === 'ITEM_VARIATION') {
              catalogObjects.push(item);
            }
          }
        }

        // Get next page cursor
        cursor = response.cursor || undefined;
      } while (cursor);
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

    // Step 1: Pre-fetch all existing mappings and products to determine what needs fetching
    console.log(`[CATALOG_SYNC] Pre-fetching existing mappings and products for ${variations.length} variations...`);
    const variationIds = variations.map(v => v.id);
    
  // Batch fetch all existing mappings
  const existingMappings = await this.prisma.catalogMapping.findMany({
    where: {
      squareVariationId: { in: variationIds },
      locationId: locationId,
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          squareProductName: true,
          squareDescription: true,
          squareImageUrl: true,
          squareVariationName: true,
          squareDataSyncedAt: true,
        },
      },
    },
  });
    
    const mappingMap = new Map(
      existingMappings.map(m => [m.squareVariationId, m])
    );

    // Batch fetch products by SKU for variations that don't have mappings
    const skus = variations
      .map(v => v.itemVariationData?.sku)
      .filter((sku): sku is string => sku !== null && sku !== undefined);
    
    const productsBySku = await this.prisma.product.findMany({
      where: {
        sku: { in: skus },
      },
    });
    
    const productBySkuMap = new Map(
      productsBySku.map(p => [p.sku!, p])
    );

    // Step 2: Determine which variations need catalog data fetched
    const variationsNeedingFetch: string[] = [];
    const variationProductMap = new Map<string, any>(); // variationId -> product
    
    for (const variation of variations) {
      const variationId = variation.id;
      const variationSku = variation.itemVariationData?.sku || null;
      const existingMapping = mappingMap.get(variationId);
      
      // Skip if mapping exists and not force resync
      if (existingMapping && !forceResync) {
        result.mappingsSkipped++;
        variationProductMap.set(variationId, existingMapping.product);
        continue;
      }

      let product = existingMapping?.product || null;
      
      if (!product && variationSku) {
        product = productBySkuMap.get(variationSku) || null;
      }

      // Determine if we need to fetch catalog data
      const needsFetch = !product || 
        !product.squareDataSyncedAt || 
        forceResync ||
        (new Date().getTime() - product.squareDataSyncedAt.getTime() > 24 * 60 * 60 * 1000); // Older than 24 hours

      if (needsFetch) {
        variationsNeedingFetch.push(variationId);
      }
      
      variationProductMap.set(variationId, product);
    }

    // Step 3: Batch fetch catalog data for variations that need it
    console.log(`[CATALOG_SYNC] Fetching catalog data for ${variationsNeedingFetch.length} variations (batched)...`);
    const catalogDataMap = variationsNeedingFetch.length > 0
      ? await this.fetchBatchCatalogObjects(variationsNeedingFetch)
      : new Map();

    // Step 4: Process each variation using cached data
    console.log(`[CATALOG_SYNC] Processing ${variations.length} variations...`);
    for (const variation of variations) {
      try {
        const variationId = variation.id;
        const variationData = variation.itemVariationData;
        const variationName = variationData?.name || 'Unknown';
        const variationSku = variationData?.sku || null;

        // Check if mapping already exists
        const existingMapping = mappingMap.get(variationId);

        // Skip if mapping exists and not force resync
        if (existingMapping && !forceResync) {
          continue; // Already counted in mappingsSkipped
        }

        // Get product from cache
        let product = variationProductMap.get(variationId) || null;

        // Get catalog data (from batch fetch or existing product data)
        let catalogData: { productName: string | null; productDescription: string | null; imageUrl: string | null };
        
        if (catalogDataMap.has(variationId)) {
          // Use freshly fetched data
          catalogData = catalogDataMap.get(variationId)!;
        } else if (product && product.squareDataSyncedAt) {
          // Use existing product data (skip fetch optimization)
          catalogData = {
            productName: product.squareProductName,
            productDescription: product.squareDescription,
            imageUrl: product.squareImageUrl,
          };
        } else {
          // Fallback: no data available
          catalogData = { productName: null, productDescription: null, imageUrl: null };
        }

        // Filter out "Sin variación" from product name
        const filteredProductName =
          catalogData.productName &&
          !catalogData.productName
            .toLowerCase()
            .includes('sin variación') &&
          !catalogData.productName
            .toLowerCase()
            .includes('no variation') &&
          catalogData.productName.trim().length > 0
            ? catalogData.productName
            : null;

        // If still no product, create new one
        if (!product) {
          product = await this.prisma.product.create({
            data: {
              name: variationName, // Keep for backward compatibility
              sku: variationSku, // May be null
              squareProductName: filteredProductName,
              squareDescription: catalogData.productDescription,
              squareImageUrl: catalogData.imageUrl,
              squareVariationName: variationName,
              squareDataSyncedAt: new Date(),
            },
          });
          result.productsCreated++;
        } else {
          // Update existing product with Square catalog data (only if we fetched new data)
          if (catalogDataMap.has(variationId) || forceResync) {
            await this.prisma.product.update({
              where: { id: product.id },
              data: {
                squareProductName: filteredProductName || product.squareProductName,
                squareDescription:
                  catalogData.productDescription || product.squareDescription,
                squareImageUrl: catalogData.imageUrl || product.squareImageUrl,
                squareVariationName: variationName || product.squareVariationName,
                squareDataSyncedAt: new Date(),
              },
            });
          }
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

