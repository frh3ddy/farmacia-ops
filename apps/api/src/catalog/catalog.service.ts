import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
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

interface CatalogData {
  productName: string | null;
  productDescription: string | null;
  imageUrl: string | null;
  priceCents: number | null;  // Selling price in cents (from price_money.amount)
  currency: string | null;     // Currency code (e.g., "USD")
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
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

      // Determine Square environment
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
      } else {
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
   * Handles "Sin variación" logic and Parent/Child image inheritance
   */
  private async fetchBatchCatalogObjects(
    variationIds: string[],
  ): Promise<Map<string, CatalogData>> {
    const client = this.getSquareClient();
    const resultMap = new Map<string, CatalogData>();
    const BATCH_SIZE = 100;

    for (let i = 0; i < variationIds.length; i += BATCH_SIZE) {
      const batch = variationIds.slice(i, i + BATCH_SIZE);

      try {
        const response = await client.catalog.batchGet({
          objectIds: batch,
          includeRelatedObjects: true,
        });

        // Normalize response structure
        const objects = (response as any).objects || [];
        const relatedObjects =
          (response as any).relatedObjects ||
          (response as any).related_objects ||
          [];

        // Process each object in the batch
        for (const obj of objects) {
          if (obj.type !== 'ITEM_VARIATION') {
            resultMap.set(obj.id, {
              productName: null,
              productDescription: null,
              imageUrl: null,
              priceCents: null,
              currency: null,
            });
            continue;
          }

          // 1. Safe Data Extraction
          const variationData =
            obj.itemVariationData || obj.item_variation_data;
          const parentId = variationData?.itemId || variationData?.item_id;
          const variationName = variationData?.name || '';

          // 2. PARENT ITEM LOOKUP (CRITICAL FIX: Match by ID)
          const itemObject = relatedObjects.find(
            (r: any) => r.type === 'ITEM' && r.id === parentId,
          );
          const itemData = itemObject?.itemData || itemObject?.item_data;
          const itemName = itemData?.name || 'Unknown Product';

          // 3. NAMING LOGIC: Filter out "Sin variación"
          const isGeneric =
            !variationName ||
            variationName.toLowerCase().includes('sin variación') ||
            variationName.toLowerCase().includes('no variation') ||
            variationName.toLowerCase().includes('regular');

          // If generic, use just "Aspirina". If specific, use "Aspirina (Small)"
          const finalName = isGeneric
            ? itemName
            : `${itemName} (${variationName})`;

          // 4. IMAGE LOGIC: Check Variation -> Then Parent Item
          let imageUrl: string | null = null;
          const varImageIds =
            variationData?.imageIds || variationData?.image_ids || [];
          const itemImageIds =
            itemData?.imageIds || itemData?.image_ids || [];
          
          // Combine IDs to check variation-specific photos first
          const allImageIds = [...varImageIds, ...itemImageIds];

          if (allImageIds.length > 0) {
            // Find the first matching image object in related objects
            const imageObj = relatedObjects.find(
              (r: any) => r.type === 'IMAGE' && r.id === allImageIds[0],
            );
            imageUrl =
              imageObj?.imageData?.url || imageObj?.image_data?.url || null;
          }

          // Extract price from variation data (handle both camelCase and snake_case)
          // In Square API, price is in itemVariationData.priceMoney or itemVariationData.price_money
          const pm = variationData?.priceMoney || variationData?.price_money;
          const rawAmount = pm?.amount;
          
          // Handle different amount types (number, string, bigint)
          let priceCents: number | null = null;
          if (rawAmount !== null && rawAmount !== undefined) {
            if (typeof rawAmount === 'number') {
              priceCents = rawAmount;
            } else if (typeof rawAmount === 'string') {
              priceCents = parseInt(rawAmount, 10);
            } else if (typeof rawAmount === 'bigint') {
              priceCents = Number(rawAmount);
            }
          }
          
          // Validate priceCents is a valid number
          if (!Number.isFinite(priceCents) || priceCents === null || priceCents < 0) {
            priceCents = null;
          }
          
          const currency = typeof pm?.currency === 'string' 
            ? pm.currency 
            : (typeof variationData?.price_money?.currency === 'string' 
                ? variationData.price_money.currency 
                : null);

          const finalPriceCents = Number.isFinite(priceCents) && priceCents !== null && priceCents >= 0 ? priceCents : null;
          
          // Log when price is found for debugging
          if (finalPriceCents !== null) {
            this.logger.debug(`[CATALOG_SYNC] Found price for variation ${obj.id}: ${finalPriceCents} cents (${currency || 'USD'})`);
          }
          
          resultMap.set(obj.id, {
            productName: finalName,
            productDescription: itemData?.description || null,
            imageUrl: imageUrl,
            priceCents: finalPriceCents,
            currency: currency || 'USD',
          });
        }
      } catch (error) {
        this.logger.warn(
          `[CATALOG_SYNC] Failed to fetch batch: ${batch.join(', ')}`,
          error,
        );
        // Fallback: Set null values so the sync doesn't crash
        for (const id of batch) {
          if (!resultMap.has(id)) {
            resultMap.set(id, {
              productName: null,
              productDescription: null,
              imageUrl: null,
              priceCents: null,
              currency: null,
            });
          }
        }
      }
    }

    return resultMap;
  }

  /**
   * Sync Square catalog items with Optimized Batch Processing
   */
  async syncSquareCatalog(
    locationId: string | null,
    forceResync: boolean,
  ): Promise<CatalogSyncResult> {
    const client = this.getSquareClient();

    // 1. Fetch ALL Variations (using cursor pagination)
    let catalogObjects: any[] = [];
    let cursor: string | undefined = undefined;

    try {
      do {
        const response = await client.catalog.search({
          objectTypes: ['ITEM_VARIATION'],
          cursor: cursor,
        });
        if (response.objects) catalogObjects.push(...response.objects);
        cursor = response.cursor || undefined;
      } while (cursor);
    } catch (error) {
      this.logger.error('[CATALOG_SYNC] Square API error:', error);
      throw new Error(`Failed to fetch catalog: ${error}`);
    }

    const variations = catalogObjects.filter(o => o.type === 'ITEM_VARIATION');

    const result: CatalogSyncResult = {
      totalVariationsFound: variations.length,
      variationsProcessed: 0,
      productsCreated: 0,
      mappingsCreated: 0,
      mappingsSkipped: 0,
      errors: [],
    };

    this.logger.log(`[CATALOG_SYNC] Found ${variations.length} variations. Starting sync...`);

    // 2. Pre-fetch Data (Minimize DB Reads)
    const variationIds = variations.map((v) => v.id);
    
    // Fetch Mappings
    const existingMappings = await this.prisma.catalogMapping.findMany({
      where: { squareVariationId: { in: variationIds }, locationId },
      include: { product: true },
    });
    const mappingMap = new Map(existingMappings.map((m) => [m.squareVariationId, m]));

    // Fetch Products by SKU
    const skus = variations
      .map((v) => v.itemVariationData?.sku)
      .filter((sku): sku is string => !!sku);
    
    const productsBySku = skus.length > 0 
      ? await this.prisma.product.findMany({ where: { sku: { in: skus } } }) 
      : [];
    const productBySkuMap = new Map(productsBySku.map((p) => [p.sku!, p]));

    // 3. Identification Phase (Who needs fetching?)
    const variationsNeedingFetch: string[] = [];
    
    // Helper to get cached product
    const getCachedProduct = (varId: string, sku: string | null) => {
        let p = mappingMap.get(varId)?.product || null;
        if (!p && sku) p = productBySkuMap.get(sku) || null;
        return p;
    };

    for (const variation of variations) {
      const p = getCachedProduct(variation.id, variation.itemVariationData?.sku || null);
      const isStale = p?.squareDataSyncedAt 
        ? (Date.now() - p.squareDataSyncedAt.getTime() > 24 * 60 * 60 * 1000) 
        : true;
      
      if (!p || isStale || forceResync) {
        variationsNeedingFetch.push(variation.id);
      }
    }

    // 4. Batch Fetch from Square
    this.logger.log(`[CATALOG_SYNC] Fetching details for ${variationsNeedingFetch.length} items...`);
    const catalogDataMap = variationsNeedingFetch.length > 0
      ? await this.fetchBatchCatalogObjects(variationsNeedingFetch)
      : new Map();

    // 5. CHUNKED EXECUTION (The Performance Fix)
    // We process 20 items in parallel. This is fast but won't exhaust the connection pool.
    const CHUNK_SIZE = 20; 
    
    for (let i = 0; i < variations.length; i += CHUNK_SIZE) {
      const batch = variations.slice(i, i + CHUNK_SIZE);
      
      // Execute batch in parallel
      await Promise.all(batch.map(async (variation) => {
        try {
          const variationId = variation.id;
          const variationData = variation.itemVariationData;
          const variationName = variationData?.name || 'Unknown';
          const variationSku = variationData?.sku || null;
          
          const existingMapping = mappingMap.get(variationId);
          if (existingMapping && !forceResync) return; // Skip logic

          // Determine Product Data
          let product = getCachedProduct(variationId, variationSku);
          
          let catalogData: CatalogData;
          if (catalogDataMap.has(variationId)) {
            catalogData = catalogDataMap.get(variationId)!;
          } else if (product) {
            catalogData = {
              productName: product.squareProductName,
              productDescription: product.squareDescription,
              imageUrl: product.squareImageUrl,
              priceCents: null,
              currency: null,
            };
          } else {
             catalogData = { 
               productName: variationName, 
               productDescription: null, 
               imageUrl: null,
               priceCents: null,
               currency: null,
             };
          }

          const squareProductName = catalogData.productName || variationName;

          // --- ATOMIC DB WRITE START ---
          // We use a transaction here to ensure Product and Mapping are synced together
          await this.prisma.$transaction(async (tx) => {
            
            // A. UPSERT PRODUCT
            if (!product) {
              // Try creating (Handle race condition with try/catch inside transaction if needed, 
              // but purely serial transactions in a batch is safer)
              try {
                product = await tx.product.create({
                  data: {
                    name: variationName,
                    sku: variationSku,
                    squareProductName: squareProductName,
                    squareDescription: catalogData.productDescription,
                    squareImageUrl: catalogData.imageUrl,
                    squareVariationName: variationName,
                    squareDataSyncedAt: new Date(),
                  },
                });
                result.productsCreated++;
              } catch (e: any) {
                // If parallel SKU create clash, recover
                if (e.code === 'P2002' && variationSku) {
                   product = await tx.product.findUnique({ where: { sku: variationSku } });
                   if (!product) throw e; 
                } else {
                  throw e;
                }
              }
            } else if (forceResync || catalogDataMap.has(variationId)) {
              product = await tx.product.update({
                where: { id: product.id },
                data: {
                  squareProductName: squareProductName,
                  squareDescription: catalogData.productDescription,
                  squareImageUrl: catalogData.imageUrl,
                  squareVariationName: variationName,
                  squareDataSyncedAt: new Date(),
                },
              });
            }

            // B. UPSERT MAPPING (with price data)
            const hasPrice = catalogData.priceCents !== null && catalogData.priceCents !== undefined && Number.isFinite(catalogData.priceCents);
            const priceData = {
              priceCents: hasPrice && catalogData.priceCents !== null
                ? new Prisma.Decimal(catalogData.priceCents) 
                : null,
              currency: catalogData.currency || 'USD',
              priceSyncedAt: hasPrice ? new Date() : null,
            };
            
            // Log when saving price for debugging
            if (hasPrice && catalogData.priceCents !== null) {
              this.logger.debug(`[CATALOG_SYNC] Saving price for variation ${variationId}: ${catalogData.priceCents} cents (${priceData.currency})`);
            }

            if (existingMapping) {
              await tx.catalogMapping.update({
                where: { id: existingMapping.id },
                data: { 
                  syncedAt: new Date(), 
                  ...priceData,
                  ...(locationId ? { locationId } : {}) 
                },
              });
            } else {
              await tx.catalogMapping.create({
                data: {
                  squareVariationId: variationId,
                  productId: product!.id,
                  locationId: locationId,
                  syncedAt: new Date(),
                  ...priceData,
                },
              });
              result.mappingsCreated++;
            }
          }); 
          // --- ATOMIC DB WRITE END ---

          // Update Memory Cache (Thread-safe enough for this logic)
          if (product && product.sku) productBySkuMap.set(product.sku, product);
          result.variationsProcessed++;

        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push({
            variationId: variation.id,
            variationName: variation.itemVariationData?.name || 'Unknown',
            error: msg,
            skipped: true,
          });
        }
      }));
    }

    return result;
  }
}