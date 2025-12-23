import { Injectable } from '@nestjs/common';
import { SquareClient, SquareEnvironment } from 'square';
import {
  SquareInventoryItem,
  SquareCatalogObject,
  SquareInventoryCount,
} from './types';
import { SquareApiError } from './errors';

@Injectable()
export class SquareInventoryService {
  private squareClient: SquareClient | null = null;

  /**
   * Get or create Square client
   */
  private getSquareClient(): SquareClient {
    if (!this.squareClient) {
      const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();

      if (!squareAccessToken) {
        throw new Error(
          'SQUARE_ACCESS_TOKEN environment variable is not set',
        );
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
   * Fetch Square inventory counts for a location
   */
  async fetchSquareInventory(
    locationId: string,
  ): Promise<SquareInventoryItem[]> {
    const client = this.getSquareClient();

    try {
      // Square SDK v40: Use inventory.batchGetCounts
      // Returns Page<InventoryCount> which has a data property
      const response = await client.inventory.batchGetCounts({
        locationIds: [locationId],
        states: ['IN_STOCK'],
      });

      // Page type has 'data' property containing the array
      const counts = (response as any).data || (response as any).counts || [];

      if (counts.length === 0) {
        return [];
      }

      const items: SquareInventoryItem[] = [];

      for (const count of counts) {
        if (
          count.catalogObjectId &&
          count.locationId &&
          count.quantity &&
          count.state === 'IN_STOCK'
        ) {
          items.push({
            catalogObjectId: count.catalogObjectId,
            locationId: count.locationId,
            quantity: parseInt(count.quantity, 10) || 0,
            catalogObject: null,
          });
        }
      }

      return items;
    } catch (error) {
      throw new SquareApiError(
        `Failed to fetch Square inventory: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
        'inventory.batchGetCounts',
      );
    }
  }

  /**
   * Fetch Square catalog object for a variation ID
   * Includes related objects to get product name and description from ITEM
   */
  async fetchSquareCatalogObject(
    variationId: string,
  ): Promise<SquareCatalogObject | null> {
    const client = this.getSquareClient();

    try {
      // Square SDK v40: Use catalog.batchGet with includeRelatedObjects to get ITEM data
      const response = await client.catalog.batchGet({
        objectIds: [variationId],
        includeRelatedObjects: true,
      });

      // batchGet returns objects array directly or in result.objects
      // Handle both SDK response format and direct API response format
      let objects: any[] = [];
      let relatedObjects: any[] = [];

      // Check for SDK format (objects array)
      if ((response as any).objects) {
        objects = (response as any).objects;
        relatedObjects = (response as any).relatedObjects || [];
      }
      // Check for direct API format (object singular + related_objects)
      else if ((response as any).object) {
        objects = [(response as any).object];
        relatedObjects = (response as any).relatedObjects || (response as any).related_objects || [];
      }
      // Fallback to data property
      else {
        objects = (response as any).data || [];
        relatedObjects = (response as any).relatedObjects || (response as any).related_objects || [];
      }

      if (objects.length === 0) {
        return null;
      }

      const obj = objects[0];

      // Handle different object types - check if it's an ITEM_VARIATION
      if (obj.type !== 'ITEM_VARIATION') {
        return null;
      }

      // Extract product name and description from related ITEM object
      let productName: string | null = null;
      let productDescription: string | null = null;

      // Find the ITEM object in related_objects
      // Handle both camelCase (SDK) and snake_case (API) property names
      const itemObject = relatedObjects.find(
        (related: any) => related.type === 'ITEM' && (related.itemData || related.item_data),
      );

      const itemData = itemObject?.itemData || itemObject?.item_data;
      let imageUrl: string | null = null;
      
      if (itemData) {
        productName = itemData.name || null;
        // Prefer description_plaintext (camelCase) or description_plaintext (snake_case), fallback to description
        productDescription =
          itemData.descriptionPlaintext ||
          itemData.description_plaintext ||
          itemData.description ||
          null;
        
        // Extract image URL from imageIds - Square stores images as IMAGE catalog objects
        // Check if itemData has imageIds array (can be imageIds or image_ids)
        const imageIds = itemData.imageIds || itemData.image_ids || [];
        
        if (imageIds && imageIds.length > 0) {
          // Try to find IMAGE object in related_objects
          const imageObject = relatedObjects.find(
            (related: any) => {
              if (related.type !== 'IMAGE') return false;
              const relatedId = related.id || related.Id || related.ID;
              return imageIds.some((imgId: string) => imgId === relatedId);
            }
          );
          
          if (imageObject) {
            // Try different property paths for image URL (Square SDK uses camelCase)
            const imageData = imageObject.imageData || imageObject.image_data;
            if (imageData) {
              // Square image URLs are in imageData.url
              imageUrl = imageData.url || null;
            }
          } else {
            // IMAGE objects might not be included in related_objects even with includeRelatedObjects: true
            // We need to fetch them explicitly
            try {
              const imageResponse = await client.catalog.batchGet({
                objectIds: [imageIds[0]], // Fetch the first image
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
                const imageData = imageObjects[0].imageData || imageObjects[0].image_data;
                if (imageData && imageData.url) {
                  imageUrl = imageData.url;
                }
              }
            } catch (imageError) {
              // If fetching image fails, log but don't throw
              console.warn(`[IMAGE] Failed to fetch image ${imageIds[0]} for variation ${variationId}:`, imageError);
            }
          }
        }
      }
      
      // Also check if the variation itself has an image (some items have variation-level images)
      if (!imageUrl) {
        const variationData = (obj as any).itemVariationData || (obj as any).item_variation_data;
        if (variationData) {
          const variationImageIds = variationData.imageIds || variationData.image_ids || [];
          if (variationImageIds && variationImageIds.length > 0) {
            // Try to find in related_objects first
            const imageObject = relatedObjects.find(
              (related: any) => {
                if (related.type !== 'IMAGE') return false;
                const relatedId = related.id || related.Id || related.ID;
                return variationImageIds.some((imgId: string) => imgId === relatedId);
              }
            );
            
            if (imageObject) {
              const imageData = imageObject.imageData || imageObject.image_data;
              if (imageData && imageData.url) {
                imageUrl = imageData.url;
              }
            } else {
              // Fetch image explicitly if not in related_objects
              try {
                const imageResponse = await client.catalog.batchGet({
                  objectIds: [variationImageIds[0]],
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
                  const imageData = imageObjects[0].imageData || imageObjects[0].image_data;
                  if (imageData && imageData.url) {
                    imageUrl = imageData.url;
                  }
                }
              } catch (imageError) {
                console.warn(`[IMAGE] Failed to fetch variation image ${variationImageIds[0]} for variation ${variationId}:`, imageError);
              }
            }
          }
        }
      }

      return {
        id: obj.id || variationId,
        type: 'ITEM_VARIATION',
        itemVariationData: (obj as any).itemVariationData || null,
        productName: productName,
        productDescription: productDescription,
        imageUrl: imageUrl,
      };
    } catch (error) {
      // If object not found, return null instead of throwing
      if (
        error instanceof Error &&
        (error.message.includes('not found') ||
          error.message.includes('404') ||
          error.message.includes('NOT_FOUND'))
      ) {
        return null;
      }

      throw new SquareApiError(
        `Failed to fetch Square catalog object: ${
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
    // Square API typically doesn't expose cost data directly
    // This is a placeholder for future implementation if Square adds cost API
    // For now, return null to indicate cost is not available from Square
    return null;
  }
}



