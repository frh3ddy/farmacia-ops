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
   */
  async fetchSquareInventory(
    locationId: string,
  ): Promise<SquareInventoryItem[]> {
    const client = this.getSquareClient();

    try {
      const response = await client.inventory.batchGetCounts({
        locationIds: [locationId],
        states: ['IN_STOCK'],
      });

      const counts = response.data || [];

      if (!counts || counts.length === 0) return [];

      // Map and Filter in one pass
      return counts.reduce<SquareInventoryItem[]>((acc, count) => {
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

      return {
        id: variationObj.id,
        type: 'ITEM_VARIATION',
        itemVariationData: varData,
        productName,
        productDescription,
        imageUrl,
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