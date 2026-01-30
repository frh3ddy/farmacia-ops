import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UnmappedProductError } from './errors';

@Injectable()
export class CatalogMapperService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Map a Square variation ID to a Product ID using CatalogMapping table
   * 
   * Algorithm:
   * 1. Look up location-specific mapping (squareVariationId + locationId)
   * 2. If not found, look up global mapping (squareVariationId + locationId = null)
   * 3. Validate mapping exists (throw UnmappedProductError if not)
   * 4. Validate product exists (throw error if not)
   * 5. Return productId
   */
  async resolveProductFromSquareVariation(
    squareVariationId: string,
    locationId: string,
  ): Promise<string> {
    // Step 1: Try location-specific mapping first
    let mapping = await this.prisma.catalogMapping.findFirst({
      where: {
        squareVariationId: squareVariationId,
        locationId: locationId,
      },
    });

    // Step 2: If not found, try global mapping (locationId is null)
    if (!mapping) {
      mapping = await this.prisma.catalogMapping.findFirst({
        where: {
          squareVariationId: squareVariationId,
          locationId: null,
        },
      });
    }

    // Step 3: Validate mapping exists
    if (!mapping) {
      throw new UnmappedProductError(
        squareVariationId,
        locationId,
        'Square variation is not mapped to a product. Please run catalog sync.',
      );
    }

    // Step 4: Validate product exists
    const product = await this.prisma.product.findUnique({
      where: { id: mapping.productId },
    });

    if (!product) {
      throw new Error(
        `Mapped product does not exist in database. Product ID: ${mapping.productId}, Mapping ID: ${mapping.id}`,
      );
    }

    // Step 5: Return product ID
    return product.id;
  }

  /**
   * Batch resolve products from Square variations
   * Returns a Map of squareVariationId -> productId
   */
  async batchResolveProductsFromSquareVariations(
    squareVariationIds: string[],
    locationId: string,
  ): Promise<Map<string, string>> {
    if (squareVariationIds.length === 0) {
      return new Map();
    }

    // Step 1: Fetch all potential mappings
    const mappings = await this.prisma.catalogMapping.findMany({
      where: {
        squareVariationId: { in: squareVariationIds },
        OR: [
          { locationId: locationId },
          { locationId: null },
        ],
      },
    });

    // Step 2: Prioritize mappings (location-specific > global)
    const variationToProductMap = new Map<string, string>();
    const variationToMappingType = new Map<string, 'LOCATION' | 'GLOBAL'>();

    for (const mapping of mappings) {
      const currentType = mapping.locationId ? 'LOCATION' : 'GLOBAL';
      const existingType = variationToMappingType.get(mapping.squareVariationId);

      // If no existing mapping, or we found a location-specific one to replace a global one
      if (!existingType || (currentType === 'LOCATION' && existingType === 'GLOBAL')) {
        variationToProductMap.set(mapping.squareVariationId, mapping.productId);
        variationToMappingType.set(mapping.squareVariationId, currentType);
      }
    }

    // Step 3: Verify products exist
    const productIds = Array.from(variationToProductMap.values());
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true },
    });

    const existingProductIds = new Set(products.map((p) => p.id));

    // Step 4: Filter out mappings where product doesn't exist
    for (const [variationId, productId] of variationToProductMap.entries()) {
      if (!existingProductIds.has(productId)) {
        variationToProductMap.delete(variationId);
      }
    }

    return variationToProductMap;
  }
}




