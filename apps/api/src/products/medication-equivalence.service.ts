import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { rankEquivalents, type EquivalenceCandidate } from './medication-equivalence';
import { CATALOG_PRODUCT_INCLUDE, toProductView, type CatalogProductView } from './catalog-product-view';

@Injectable()
export class MedicationEquivalenceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Other active products sharing the same MedicationDefinition, in-stock first then cheapest first. */
  async findEquivalentProducts(productId: string, locationId?: string): Promise<CatalogProductView[]> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, medicationDefinitionId: true },
    });
    if (!product?.medicationDefinitionId) return [];

    const candidates = await this.prisma.product.findMany({
      where: {
        medicationDefinitionId: product.medicationDefinitionId,
        id: { not: productId },
        isDiscontinued: false,
      },
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
    return rankEquivalents(product, equivalenceInput).map((c) => byId.get(c.id)!);
  }
}
