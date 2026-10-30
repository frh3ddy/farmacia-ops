import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { rankEquivalents, type EquivalenceCandidate } from './medication-equivalence';
import { CATALOG_PRODUCT_INCLUDE, soldAt, toProductView, type CatalogProductView } from './catalog-product-view';

@Injectable()
export class MedicationEquivalenceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Other active products sharing the same MedicationDefinition, in-stock first then cheapest first. */
  async findEquivalentProducts(productId: string, locationId?: string): Promise<CatalogProductView[]> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, medicationDefinitionId: true },
    });
    if (!product) return [];
    return (await this.findEquivalentsOf([product], locationId)).get(product.id) ?? [];
  }

  /** Each product's equivalents, ranked as above, from one query for all of them. */
  async findEquivalentsOf(
    products: { id: string; medicationDefinitionId: string | null }[],
    locationId?: string,
  ): Promise<Map<string, CatalogProductView[]>> {
    const definitionIds = [...new Set(products.map((p) => p.medicationDefinitionId).filter((id): id is string => !!id))];
    if (definitionIds.length === 0) return new Map();

    const candidates = await this.prisma.product.findMany({
      where: { AND: [{ medicationDefinitionId: { in: definitionIds }, isDiscontinued: false }, soldAt(locationId)] },
      include: CATALOG_PRODUCT_INCLUDE(locationId),
    });

    const views = candidates.map((c) => toProductView(c, locationId));
    const equivalenceInput: EquivalenceCandidate[] = views.map((v) => ({
      id: v.id,
      medicationDefinitionId: v.medicationDefinitionId,
      isDiscontinued: v.isDiscontinued,
      inStock: v.inStock,
      price: v.price,
    }));
    const byId = new Map(views.map((v) => [v.id, v]));
    return new Map(products.map((p) => [p.id, rankEquivalents(p, equivalenceInput).map((c) => byId.get(c.id)!)]));
  }
}
