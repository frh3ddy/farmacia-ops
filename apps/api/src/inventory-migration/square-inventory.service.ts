import { Injectable, Logger } from '@nestjs/common';
import { SquareClient, SquareEnvironment, Square } from 'square';
import {
  SquareInventoryItem,
  SquareCatalogObject,
} from './types';
import { SquareApiError } from './errors';

@Injectable()
export class SquareInventoryService {
  private readonly logger = new Logger(SquareInventoryService.name);
  private squareClient: SquareClient | null = null;

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
   * Fetch Square inventory counts for a location
   * Implements pagination to fetch all items (not just the first 1000)
   */
  async fetchSquareInventory(
    locationId: string,
  ): Promise<SquareInventoryItem[]> {
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

      const variationObj = objects[0];
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

  async fetchSquareCost(variationId: string): Promise<number | null> {
    return null;
  }
}