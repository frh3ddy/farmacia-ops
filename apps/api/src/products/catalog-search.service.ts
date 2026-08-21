import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MedicationEquivalenceService } from './medication-equivalence.service';
import { CATALOG_PRODUCT_INCLUDE, toProductView, type CatalogProductView } from './catalog-product-view';
import { rankSearchCandidates, buildSearchResult, isStrongMatch, type MatchType, type SearchCandidate } from './catalog-search';
import { stripAccents } from '../inventory-migration/category-classifier';

type SearchProductCandidate = CatalogProductView & { matchType: MatchType };

@Injectable()
export class CatalogSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly equivalenceService: MedicationEquivalenceService,
  ) {}

  async search(
    query: string,
    locationId?: string,
  ): Promise<{ requested: SearchProductCandidate[]; alternatives: CatalogProductView[]; alternativesChecked: boolean }> {
    const q = query.trim();
    if (!q) return { requested: [], alternatives: [], alternativesChecked: false };
    const normalizedQuery = stripAccents(q.toLowerCase());

    const include = CATALOG_PRODUCT_INCLUDE(locationId);

    const [skuMatches, nameMatches, ingredientMatches, definitionMatches] = await Promise.all([
      this.prisma.product.findMany({
        where: { sku: { equals: q, mode: 'insensitive' }, isDiscontinued: false },
        include,
      }),
      this.prisma.product.findMany({
        where: {
          isDiscontinued: false,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { squareProductName: { contains: q, mode: 'insensitive' } },
          ],
        },
        include,
      }),
      this.prisma.activeIngredient.findMany({
        where: {
          OR: [{ name: { contains: q, mode: 'insensitive' } }, { aliases: { has: normalizedQuery } }],
        },
        include: {
          ingredients: {
            include: {
              medicationDefinition: {
                include: { products: { where: { isDiscontinued: false }, include } },
              },
            },
          },
        },
      }),
      this.prisma.medicationDefinition.findMany({
        where: { name: { contains: q, mode: 'insensitive' } },
        include: { products: { where: { isDiscontinued: false }, include } },
      }),
    ]);

    const candidates: SearchProductCandidate[] = [];

    for (const product of skuMatches) {
      candidates.push({ ...toProductView(product, locationId), matchType: 'sku' });
    }

    for (const product of nameMatches) {
      const isExact = stripAccents(product.name.toLowerCase()) === normalizedQuery;
      candidates.push({ ...toProductView(product, locationId), matchType: isExact ? 'name-exact' : 'name-contains' });
    }

    for (const ingredient of ingredientMatches) {
      const isExact =
        stripAccents(ingredient.name.toLowerCase()) === normalizedQuery ||
        ingredient.aliases.includes(normalizedQuery);
      const matchType: MatchType = isExact ? 'ingredient-exact' : 'ingredient-contains';
      for (const join of ingredient.ingredients) {
        for (const product of join.medicationDefinition.products) {
          candidates.push({ ...toProductView(product, locationId), matchType });
        }
      }
    }

    for (const definition of definitionMatches) {
      for (const product of definition.products) {
        candidates.push({ ...toProductView(product, locationId), matchType: 'definition-contains' });
      }
    }

    const ranked = rankSearchCandidates(candidates);
    const top = ranked[0];
    const alternativesChecked = Boolean(top && isStrongMatch(top as SearchCandidate) && !top.inStock);

    const alternatives = alternativesChecked
      ? await this.equivalenceService.findEquivalentProducts(top.id, locationId)
      : [];

    return { ...buildSearchResult(ranked, () => alternatives), alternativesChecked };
  }
}
