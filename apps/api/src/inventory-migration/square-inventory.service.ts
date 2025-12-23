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
   */
  async fetchSquareCatalogObject(
    variationId: string,
  ): Promise<SquareCatalogObject | null> {
    const client = this.getSquareClient();

    try {
      // Square SDK v40: Use catalog.batchGet
      const response = await client.catalog.batchGet({
        objectIds: [variationId],
      });

      // batchGet returns objects array directly or in result.objects
      const objects = (response as any).objects || (response as any).data || [];

      if (objects.length === 0) {
        return null;
      }

      const obj = objects[0];

      // Handle different object types - check if it's an ITEM_VARIATION
      if (obj.type !== 'ITEM_VARIATION') {
        return null;
      }

      return {
        id: obj.id || variationId,
        type: 'ITEM_VARIATION',
        itemVariationData: (obj as any).itemVariationData || null,
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



