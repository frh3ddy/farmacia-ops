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

interface CatalogData {
  productName: string | null;
  productDescription: string | null;
  imageUrl: string | null;
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

    squareClient = new SquareClient({
      token: squareAccessToken,
      environment: squareEnvironment,
    });
  }
  return squareClient;
}

/**
 * Fetch multiple catalog objects in batch from Square
 * Handles "Sin variación" logic and Parent/Child image inheritance
 */
async function fetchBatchCatalogObjects(
  variationIds: string[],
): Promise<Map<string, CatalogData>> {
  const client = getSquareClient();
  const resultMap = new Map<string, CatalogData>();

  const BATCH_SIZE = 100;
  
  for (let i = 0; i < variationIds.length; i += BATCH_SIZE) {
    const batch = variationIds.slice(i, i + BATCH_SIZE);
    
    try {
      const response = await client.catalog.batchGet({
        objectIds: batch,
        includeRelatedObjects: true,
      });

      // Normalize response structure across SDK versions
      const objects = (response as any).objects || [];
      const relatedObjects = (response as any).relatedObjects || (response as any).related_objects || [];

      // Process each variation in the current batch
      for (const variation of objects) {
        if (variation.type !== 'ITEM_VARIATION') continue;

        const variationData = variation.itemVariationData || variation.item_variation_data;
        const parentId = variationData?.itemId || variationData?.item_id;
        const variationName = variationData?.name || '';

        // 1. MATCH: Find the EXACT parent item for this variation
        const itemObject = relatedObjects.find((r: any) => r.type === 'ITEM' && r.id === parentId);
        const itemData = itemObject?.itemData || itemObject?.item_data;
        const itemName = itemData?.name || 'Unknown Product';

        // 2. LOGIC: Resolve the display name (Filter out "Sin variación")
        const isGeneric = 
          !variationName || 
          variationName.toLowerCase().includes('sin variación') || 
          variationName.toLowerCase().includes('regular');

        // Result: "Aspirina" instead of "Sin variación"
        const finalName = isGeneric ? itemName : `${itemName} (${variationName})`;

        // 3. IMAGE FALLBACK: Check variation first, then parent item
        let imageUrl: string | null = null;
        const varImageIds = variationData?.imageIds || variationData?.image_ids || [];
        const itemImageIds = itemData?.imageIds || itemData?.image_ids || [];
        
        // Combine IDs to check variation-specific photos first
        const allImageIds = [...varImageIds, ...itemImageIds];

        if (allImageIds.length > 0) {
          const imageObj = relatedObjects.find((r: any) => 
            r.type === 'IMAGE' && r.id === allImageIds[0]
          );
          imageUrl = imageObj?.imageData?.url || imageObj?.image_data?.url || null;
        }

        resultMap.set(variation.id, {
          productName: finalName,
          productDescription: itemData?.description || null,
          imageUrl: imageUrl
        });
      }
    } catch (error) {
      console.warn(`[CATALOG_SYNC] Batch error:`, error);
      // Fallback: Set null values so the sync doesn't crash
      for (const id of batch) {
        if (!resultMap.has(id)) {
          resultMap.set(id, {
            productName: null,
            productDescription: null,
            imageUrl: null,
          });
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
async function fetchFullCatalogObject(
  variationId: string,
): Promise<{
  productName: string | null;
  productDescription: string | null;
  imageUrl: string | null;
}> {
  const client = getSquareClient();

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
 * Sync Square catalog items with Optimized Batch Processing
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
    console.error('[CATALOG_SYNC] Square API error:', error);
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

  console.log(`[CATALOG_SYNC] Found ${variations.length} variations. Starting sync...`);

  // 2. Pre-fetch Data (Minimize DB Reads)
  const variationIds = variations.map((v) => v.id);
  
  // Fetch Mappings
  const existingMappings = await prismaClient.catalogMapping.findMany({
    where: { squareVariationId: { in: variationIds }, locationId },
    include: { product: true },
  });
  const mappingMap = new Map(existingMappings.map((m) => [m.squareVariationId, m]));

  // Fetch Products by SKU
  const skus = variations
    .map((v) => v.itemVariationData?.sku)
    .filter((sku): sku is string => !!sku);
  
  const productsBySku = skus.length > 0 
    ? await prismaClient.product.findMany({ where: { sku: { in: skus } } }) 
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
  console.log(`[CATALOG_SYNC] Fetching details for ${variationsNeedingFetch.length} items...`);
  const catalogDataMap = variationsNeedingFetch.length > 0
    ? await fetchBatchCatalogObjects(variationsNeedingFetch)
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
        if (existingMapping && !forceResync) {
          result.mappingsSkipped++;
          return; // Skip logic
        }

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
          };
        } else {
           catalogData = { productName: variationName, productDescription: null, imageUrl: null };
        }

        const squareProductName = catalogData.productName || variationName;

        // --- ATOMIC DB WRITE START ---
        // We use a transaction here to ensure Product and Mapping are synced together
        // Type assertion needed because prismaClient type omits $transaction, but it exists at runtime
        const prismaWithTransaction = prismaClient as any;
        await prismaWithTransaction.$transaction(async (tx: any) => {
          
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

          // B. UPSERT MAPPING
          if (existingMapping) {
            await tx.catalogMapping.update({
              where: { id: existingMapping.id },
              data: { syncedAt: new Date(), ...(locationId ? { locationId } : {}) },
            });
          } else {
            await tx.catalogMapping.create({
              data: {
                squareVariationId: variationId,
                productId: product!.id,
                locationId: locationId,
                syncedAt: new Date(),
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

