import { BadRequestException } from '@nestjs/common';

/**
 * Stock may only be added where the product is sold. A product sold only at one
 * store is hidden from the others' lists, so stock added there would be invisible
 * (and fail to sync to Square, which has no such item there). Removals stay
 * allowed everywhere, so stock that got somewhere it shouldn't can be cleaned up.
 */
export function assertSoldAtLocation(product: { soldOnlyAtLocationId: string | null }, locationId: string): void {
  if (product.soldOnlyAtLocationId && product.soldOnlyAtLocationId !== locationId) {
    throw new BadRequestException({
      success: false,
      code: 'PRODUCT_NOT_SOLD_AT_LOCATION',
      message: 'Este producto no se vende en esta tienda.',
    });
  }
}
