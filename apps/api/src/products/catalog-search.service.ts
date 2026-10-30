import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MedicationEquivalenceService } from './medication-equivalence.service';
import { CATALOG_PRODUCT_INCLUDE, soldAt, toProductView, type CatalogProductView } from './catalog-product-view';
import {
  rankSearchCandidates,
  buildSearchResult,
  shouldShowAlternatives,
  matchSearchAlias,
  matchSymptomKeyword,
  type MatchType,
} from './catalog-search';
import { stripAccents } from '../common/strip-accents';

type SearchProductCandidate = CatalogProductView & { matchType: MatchType };

/** The most products one search returns, and loads from any one branch — as the product list's search. */
const SEARCH_LIMIT = 500;

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
    const visible = soldAt(locationId);
    const oneStoreSql = locationId
      ? Prisma.sql`AND ("soldOnlyAtLocationId" IS NULL OR "soldOnlyAtLocationId" = ${locationId})`
      : Prisma.empty;

    // Prisma's `contains` can't ignore accents, so "Suspension" would miss a
    // product named "Suspensión" — translate() strips accents at the DB level
    // (native to Postgres, no unaccent extension needed) before comparing.
    const nameMatchIds = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Product"
      WHERE "isDiscontinued" = false
        AND (
          POSITION(${normalizedQuery} IN translate(lower(name), 'áéíóúñü', 'aeiounu')) > 0
          OR POSITION(${normalizedQuery} IN translate(lower(COALESCE("squareProductName", '')), 'áéíóúñü', 'aeiounu')) > 0
        )
        ${oneStoreSql}
      LIMIT ${SEARCH_LIMIT}
    `;

    const [skuMatches, nameMatches, aliasMatches, ingredientMatches, definitionMatches, categoryMatches] = await Promise.all([
      this.prisma.product.findMany({
        where: { AND: [{ sku: { equals: q, mode: 'insensitive' }, isDiscontinued: false }, visible] },
        include,
        take: SEARCH_LIMIT,
      }),
      nameMatchIds.length
        ? this.prisma.product.findMany({ where: { id: { in: nameMatchIds.map((r) => r.id) } }, include })
        : Promise.resolve([]),
      this.prisma.product.findMany({
        // Prisma's array `has` is exact-membership only, so this can't filter
        // by substring at the DB level — fetch every tagged product (cheap;
        // most products carry none) and substring-match in JS below.
        where: { AND: [{ isDiscontinued: false, searchAliases: { isEmpty: false } }, visible] },
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
                include: { products: { where: { AND: [{ isDiscontinued: false }, visible] }, include, take: SEARCH_LIMIT } },
              },
            },
          },
        },
        take: SEARCH_LIMIT,
      }),
      this.prisma.medicationDefinition.findMany({
        where: { name: { contains: q, mode: 'insensitive' } },
        include: { products: { where: { AND: [{ isDiscontinued: false }, visible] }, include, take: SEARCH_LIMIT } },
        take: SEARCH_LIMIT,
      }),
      this.prisma.category.findMany({
        // Category count is small (~100 rows) — cheap to fetch every symptom-tagged
        // category and substring-match in JS, same pattern as aliasMatches above.
        where: { symptomKeywords: { isEmpty: false } },
        include: { children: { select: { id: true } } },
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

    // Map each matched category (and its children, so a match on a parent
    // category pulls in every subcategory's products too) to its match
    // strength, so a product only inherits the exact tier from its own
    // category — not from some other unrelated category that also matched.
    const categoryIdToMatchType = new Map<string, 'category-keyword-exact' | 'category-keyword-contains'>();
    for (const category of categoryMatches) {
      const matchType = matchSymptomKeyword(category.symptomKeywords, normalizedQuery);
      if (!matchType) continue;
      for (const id of [category.id, ...category.children.map((c) => c.id)]) {
        categoryIdToMatchType.set(id, matchType);
      }
    }
    if (categoryIdToMatchType.size) {
      const categoryProducts = await this.prisma.product.findMany({
        where: { AND: [{ categoryId: { in: [...categoryIdToMatchType.keys()] }, isDiscontinued: false }, visible] },
        include,
        take: SEARCH_LIMIT,
      });
      for (const product of categoryProducts) {
        candidates.push({
          ...toProductView(product, locationId),
          matchType: categoryIdToMatchType.get(product.categoryId!) ?? 'category-keyword-contains',
        });
      }
    }

    const ranked = rankSearchCandidates(candidates).slice(0, SEARCH_LIMIT);
    const alternativesChecked = shouldShowAlternatives(ranked);

    const alternatives = alternativesChecked
      ? await this.equivalenceService.findEquivalentProducts(ranked[0].id, locationId)
      : [];

    const result = buildSearchResult(ranked, () => alternatives);

    // Always tag each result with its own equivalents (same MedicationDefinition),
    // in stock or not — not just the out-of-stock top-match branch above.
    const equivalents = await this.equivalenceService.findEquivalentsOf(result.requested, locationId);
    const requested = result.requested.map((p) => ({ ...p, equivalents: equivalents.get(p.id) ?? [] }));

    return { requested, alternatives: result.alternatives, alternativesChecked };
  }
}
