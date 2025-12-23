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
}



