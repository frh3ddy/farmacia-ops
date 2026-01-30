import { Injectable, Logger } from '@nestjs/common';
import { SquareClient, SquareEnvironment, Square } from 'square';
import {
  SquareInventoryItem,
  SquareCatalogObject,
} from './types';
import { SquareApiError } from './errors';

// Cache entry for inventory items
interface InventoryCacheEntry {
  items: SquareInventoryItem[];
  cachedAt: Date;
  locationId: string;
}

@Injectable()
export class SquareInventoryService {
  private readonly logger = new Logger(SquareInventoryService.name);
  private squareClient: SquareClient | null = null;
  
  // In-memory cache for inventory items, keyed by locationId
  private inventoryCache = new Map<string, InventoryCacheEntry>();
  
  // Cache TTL in milliseconds (5 minutes - inventory doesn't change that often during migration)
  private readonly INVENTORY_CACHE_TTL_MS = 5 * 60 * 1000;

  /**
   * Get or create Square client
   */
  private getSquareClient(): SquareClient {
    if (!this.squareClient) {
      const token = process.env.SQUARE_ACCESS_TOKEN?.trim();
      if (!token) throw new Error('SQUARE_ACCESS_TOKEN is not set');

      const env = process.env.SQUARE_ENVIRONMENT?.toLowerCase();
      const nodeEnv = process.env.NODE_ENV?.toLowerCase();
      
      const isSandbox = 
        env === 'sandbox' || 
        nodeEnv === 'development' || 
        process.env.RAILWAY_ENVIRONMENT === 'staging';

      this.squareClient = new SquareClient({
        token,
        environment: isSandbox ? SquareEnvironment.Sandbox : SquareEnvironment.Production,
      });
    }
    return this.squareClient;
  }

  /**
   * Clear the inventory cache for a specific location or all locations
   */
  clearInventoryCache(locationId?: string): void {
    if (locationId) {
      this.inventoryCache.delete(locationId);
      this.logger.log(`Cleared inventory cache for location ${locationId}`);
    } else {
      this.inventoryCache.clear();
      this.logger.log('Cleared all inventory cache');
    }
  }

  /**
   * Check if cached inventory is still valid
   */
  private isCacheValid(entry: InventoryCacheEntry): boolean {
    const age = Date.now() - entry.cachedAt.getTime();
    return age < this.INVENTORY_CACHE_TTL_MS;
  }

  /**
   * Fetch Square inventory counts for a location
   * Implements pagination to fetch all items (not just the first 1000)
   * Uses in-memory caching to avoid repeated fetches during batch processing
   */
  async fetchSquareInventory(
    locationId: string,
    skipCache: boolean = false,
  ): Promise<SquareInventoryItem[]> {
    // Check cache first (unless explicitly skipped)
    if (!skipCache) {
      const cached = this.inventoryCache.get(locationId);
      if (cached && this.isCacheValid(cached)) {
        this.logger.log(`Using cached inventory for location ${locationId} (${cached.items.length} items, cached ${Math.round((Date.now() - cached.cachedAt.getTime()) / 1000)}s ago)`);
        return cached.items;
      }
    }

    const client = this.getSquareClient();
    const allItems: SquareInventoryItem[] = [];
    let cursor: string | undefined = undefined;

    try {
      do {
        const response = await client.inventory.batchGetCounts({
          locationIds: [locationId],
          states: ['IN_STOCK'],
          cursor: cursor, // Use cursor for pagination
        });

        const responseAny = response as any;
        
        // Square SDK v40 uses a paginated response object with methods
        // Response has: response, data, _hasNextPage, getItems, loadNextPage
        // Extract counts from data property
        const counts = responseAny.data || 
                       (responseAny.response && responseAny.response.data) ||
                       responseAny.counts || 
                       [];

        if (!counts || counts.length === 0) {
          this.logger.log(`No more counts returned, stopping pagination`);
          break;
        }

        // Map and Filter in one pass
        const pageItems = counts.reduce((acc: SquareInventoryItem[], count: any) => {
          if (
            count.catalogObjectId &&
            count.locationId &&
            count.quantity &&
            count.state === 'IN_STOCK'
          ) {
            acc.push({
              catalogObjectId: count.catalogObjectId,
              locationId: count.locationId,
              quantity: parseInt(count.quantity, 10) || 0,
              catalogObject: null,
            });
          }
          return acc;
        }, []);

        allItems.push(...pageItems);
        this.logger.log(`Fetched page with ${pageItems.length} items (total so far: ${allItems.length})`);

        // Square SDK v40 paginated response structure
        // Check _hasNextPage to see if there are more pages
        const hasNextPage = responseAny._hasNextPage === true;
        
        // Get cursor from response.response.cursor for next iteration
        // The actual API response with cursor is in the 'response' property
        cursor = responseAny.response?.cursor || 
                 responseAny.response?.cursor_ ||
                 responseAny.cursor || 
                 responseAny.cursor_ || 
                 undefined;

        // Debug log on first page to understand structure
        if (!cursor && allItems.length === pageItems.length) {
          this.logger.log(`[DEBUG] First page: _hasNextPage=${hasNextPage}, cursor=${cursor ? 'found' : 'not found'}`);
          if (responseAny.response) {
            this.logger.log(`[DEBUG] response.response keys: ${Object.keys(responseAny.response).join(', ')}`);
            if (responseAny.response.cursor) {
              this.logger.log(`[DEBUG] Found cursor in response.response.cursor`);
            }
          }
        }

        if (hasNextPage && !cursor) {
          this.logger.warn(`_hasNextPage is true but no cursor found - pagination may fail`);
        }

        if (cursor) {
          this.logger.log(`Cursor found, will fetch next page`);
        } else {
          this.logger.log(`No cursor in response, pagination complete`);
          cursor = undefined; // Explicitly set to exit loop
        }

      } while (cursor); // Continue while there's a cursor for next page

      this.logger.log(`Total inventory items fetched: ${allItems.length}`);
      
      // Cache the results
      this.inventoryCache.set(locationId, {
        items: allItems,
        cachedAt: new Date(),
        locationId,
      });
      this.logger.log(`Cached inventory for location ${locationId}`);
      
      return allItems;

    } catch (error) {
      throw new SquareApiError(
        `Inventory fetch failed: ${error}`,
        error,
        'inventory.batchGetCounts',
      );
    }
  }

  /**
   * Helper to parse a variation object into our internal SquareCatalogObject format
   */
  private parseCatalogObject(
    variationObj: any, 
    relatedObjects: any[]
  ): SquareCatalogObject | null {
      if (variationObj.type !== 'ITEM_VARIATION') return null;

      // 1. Safe Data Extraction
      const varData = variationObj.itemVariationData;
      const parentId = varData?.itemId;

      // 2. Find Parent Item (in related objects)
      const parentObj = relatedObjects.find(
        (r) => r.type === 'ITEM' && r.id === parentId
      ) as Square.CatalogObject.Item | undefined;
      const itemData = parentObj?.itemData;

      // 3. Name & Description Resolution
      const productName = itemData?.name || null;
      const productDescription = 
        itemData?.descriptionPlaintext || 
        itemData?.description || 
        null;

      // 4. Image Resolution (Priority: Variation -> Parent)
      let imageUrl: string | null = null;
      
      const varImageIds = varData?.imageIds || [];
      const itemImageIds = itemData?.imageIds || [];
      
      // Combine IDs: check variation specific images first
      const possibleImageIds = [...varImageIds, ...itemImageIds];

      if (possibleImageIds.length > 0) {
        // Find the first ID that exists in the related objects map
        const foundImageObj = relatedObjects.find(
          (r) => r.type === 'IMAGE' && possibleImageIds.includes(r.id)
        ) as Square.CatalogObject.Image | undefined;
        
        if (foundImageObj?.imageData?.url) {
          imageUrl = foundImageObj.imageData.url;
        }
      }

      // Normalize selling price (Square Money amount is in cents)
      // Handle both camelCase (SDK) and snake_case (raw API) formats
      const pm = (varData as any)?.priceMoney || (varData as any)?.price_money;
      const rawAmount = pm?.amount;

      const variationPriceCents =
        typeof rawAmount === 'number'
          ? rawAmount
          : typeof rawAmount === 'string'
            ? parseInt(rawAmount, 10)
            : null;

      const variationCurrency = typeof pm?.currency === 'string' 
        ? pm.currency 
        : (typeof (varData as any)?.price_money?.currency === 'string' 
            ? (varData as any).price_money.currency 
            : null);

      return {
        id: variationObj.id,
        type: 'ITEM_VARIATION',
        itemVariationData: varData,
        productName,
        productDescription,
        imageUrl,
        variationPriceCents:
          Number.isFinite(variationPriceCents) && (variationPriceCents as number) >= 0
            ? (variationPriceCents as number)
            : null,
        variationCurrency,
      };
  }

  /**
   * Fetch Square catalog object for a variation ID
   * Optimized to determine Product Name and Image without secondary API calls
   */
  async fetchSquareCatalogObject(
    variationId: string,
  ): Promise<SquareCatalogObject | null> {
    const client = this.getSquareClient();

    try {
      const response = await client.catalog.batchGet({
        objectIds: [variationId],
        includeRelatedObjects: true,
      });

      const objects = response.objects || [];
      const relatedObjects = response.relatedObjects || [];

      if (objects.length === 0) return null;

      return this.parseCatalogObject(objects[0], relatedObjects);

    } catch (error) {
      // 404 handling
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('not found') || msg.includes('404')) {
        return null;
      }

      throw new SquareApiError(
        `Catalog fetch failed: ${msg}`,
        error,
        'catalog.batchGet',
      );
    }
  }

  /**
   * Batch fetch Square catalog objects for multiple variation IDs
   */
  async batchFetchSquareCatalogObjects(
    variationIds: string[],
  ): Promise<Map<string, SquareCatalogObject>> {
    const client = this.getSquareClient();
    const result = new Map<string, SquareCatalogObject>();

    if (variationIds.length === 0) {
      return result;
    }

    try {
      // Square API allows up to 1000 IDs per call usually, but let's stick to safe chunks of 100
      const chunkSize = 100;
      for (let i = 0; i < variationIds.length; i += chunkSize) {
        const chunk = variationIds.slice(i, i + chunkSize);
        
        // Include related objects to get images and parent item data (for name/desc)
        const response = await client.catalog.batchGet({
          objectIds: chunk,
          includeRelatedObjects: true,
        });

        const objects = (response as any).objects || (response as any).data || [];
        const relatedObjects = (response as any).relatedObjects || [];

        for (const obj of objects) {
           const parsed = this.parseCatalogObject(obj, relatedObjects);
           if (parsed) {
             result.set(parsed.id, parsed);
           }
        }
      }

      return result;
    } catch (error) {
      throw new SquareApiError(
        `Failed to batch fetch Square catalog objects: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
        'catalog.batchGet',
      );
    }
  }

  /**
   * Attempt to fetch cost from Square (if available)
   * Note: Square API may not always provide cost data
   */
  async fetchSquareCost(variationId: string): Promise<number | null> {
    return null;
  }
}
