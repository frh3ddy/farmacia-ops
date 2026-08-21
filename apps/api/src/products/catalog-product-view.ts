/**
 * Shared shape + mapper for a Product as shown in catalog search / equivalence
 * results. Mirrors the availability/price computation already used by
 * ProductsService.getProducts (mapping preference: location-specific over
 * global, sum of inventories.quantity) so search results stay consistent
 * with the rest of the app.
 */
import { Prisma } from '@prisma/client';

export const CATALOG_PRODUCT_INCLUDE = (locationId?: string) =>
  ({
    laboratory: { select: { id: true, name: true } },
    catalogMappings: {
      where: locationId
        ? { OR: [{ locationId }, { locationId: null }] }
        : undefined,
      orderBy: { locationId: 'desc' as const },
    },
    inventories: locationId ? { where: { locationId } } : true,
  }) satisfies Prisma.ProductInclude;

type CatalogProduct = Prisma.ProductGetPayload<{ include: ReturnType<typeof CATALOG_PRODUCT_INCLUDE> }>;

export type CatalogProductView = {
  id: string;
  name: string;
  sku: string | null;
  medicationType: string | null;
  medicationDefinitionId: string | null;
  isDiscontinued: boolean;
  laboratoryName: string | null;
  presentation: string | null;
  requiresPrescription: boolean;
  isControlled: boolean;
  price: number | null;
  currency: string;
  quantity: number;
  inStock: boolean;
};

export function toProductView(product: CatalogProduct, locationId?: string): CatalogProductView {
  const mapping = locationId
    ? (product.catalogMappings.find((m) => m.locationId === locationId) ??
      product.catalogMappings.find((m) => m.locationId === null))
    : product.catalogMappings[0];

  const quantity = product.inventories.reduce((sum, inv) => sum + inv.quantity, 0);

  return {
    id: product.id,
    name: product.squareProductName || product.name,
    sku: product.sku,
    medicationType: product.medicationType,
    medicationDefinitionId: product.medicationDefinitionId,
    isDiscontinued: product.isDiscontinued,
    laboratoryName: product.laboratory?.name ?? null,
    presentation: product.presentation,
    requiresPrescription: product.requiresPrescription,
    isControlled: product.isControlled,
    price: mapping ? Number(mapping.priceCents) / 100 : null,
    currency: mapping?.currency || 'USD',
    quantity,
    inStock: quantity > 0,
  };
}
