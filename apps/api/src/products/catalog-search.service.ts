import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MedicationEquivalenceService } from './medication-equivalence.service';
import { CATALOG_PRODUCT_INCLUDE, toProductView, type CatalogProductView } from './catalog-product-view';
import { rankSearchCandidates, buildSearchResult, shouldShowAlternatives, matchSearchAlias, type MatchType } from './catalog-search';
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
  ): Promise<{
    requested: (SearchProductCandidate & { equivalents: CatalogProductView[] })[];
    alternatives: CatalogProductView[];
    alternativesChecked: boolean;
  }> {
    const q = query.trim();
    if (!q) return { requested: [], alternatives: [], alternativesChecked: false };
    const normalizedQuery = stripAccents(q.toLowerCase());

    const include = CATALOG_PRODUCT_INCLUDE(locationId);

    const [skuMatches, nameMatches, aliasMatches, ingredientMatches, definitionMatches] = await Promise.all([
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
      this.prisma.product.findMany({
        // Prisma's array `has` is exact-membership only, so this can't filter
        // by substring at the DB level — fetch every tagged product (cheap;
        // most products carry none) and substring-match in JS below.
        where: { isDiscontinued: false, searchAliases: { isEmpty: false } },
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

    for (const product of aliasMatches) {
      const matchType = matchSearchAlias(product.searchAliases, normalizedQuery);
      if (matchType) {
        candidates.push({ ...toProductView(product, locationId), matchType });
      }
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
    const alternativesChecked = shouldShowAlternatives(ranked);

    const alternatives = alternativesChecked
      ? await this.equivalenceService.findEquivalentProducts(ranked[0].id, locationId)
      : [];

    const result = buildSearchResult(ranked, () => alternatives);

    // Always tag each result with its own equivalents (same MedicationDefinition),
    // in stock or not — not just the out-of-stock top-match branch above.
    const requested = await Promise.all(
      result.requested.map(async (p) => ({
        ...p,
        equivalents: p.medicationDefinitionId
          ? await this.equivalenceService.findEquivalentProducts(p.id, locationId)
          : [],
      })),
    );

    return { requested, alternatives: result.alternatives, alternativesChecked };
  }
}
