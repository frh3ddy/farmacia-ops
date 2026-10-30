/**
 * Shared shape + mapper for a Product as shown in catalog search / equivalence
 * results. Price comes from the mapping preferredMapping picks and stock is
 * the sum of the location's batches, as in ProductsService.getProducts, so
 * search results agree with the product list.
 */
import { Prisma } from '@prisma/client';
import { preferredMapping } from '../inventory/square-sync';

/**
 * Products a location's lists show: everything except another store's
 * one-store products. No location (the owner's every-store view): everything.
 */
export const soldAt = (locationId?: string): Prisma.ProductWhereInput =>
  locationId ? { OR: [{ soldOnlyAtLocationId: null }, { soldOnlyAtLocationId: locationId }] } : {};

export const CATALOG_PRODUCT_INCLUDE = (locationId?: string) =>
  ({
    laboratory: { select: { id: true, name: true } },
    catalogMappings: { orderBy: { createdAt: 'desc' as const } },
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
  searchAliases: string[];
};

export function toProductView(product: CatalogProduct, locationId?: string): CatalogProductView {
  const mapping = preferredMapping(product.catalogMappings, locationId);

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
    searchAliases: product.searchAliases,
  };
}
