/**
 * Pure search ranking/grouping logic — data in, results out, no DB access,
 * so it's directly unit-testable (see scripts/test-medication-equivalence.ts).
 * catalog-search.service.ts gathers candidates from Prisma, tags each with a
 * matchType, and hands them to this module.
 */
import { rankEquivalents, type EquivalenceCandidate } from './medication-equivalence';
import { stripAccents } from '../inventory-migration/category-classifier';

export type MatchType =
  | 'sku'
  | 'name-exact'
  | 'alias-exact'
  | 'ingredient-exact'
  | 'category-keyword-exact'
  | 'definition-contains'
  | 'alias-contains'
  | 'ingredient-contains'
  | 'name-contains'
  | 'category-keyword-contains';

export type SearchCandidate = EquivalenceCandidate & {
  matchType: MatchType;
};

// Priority order from the spec: exact barcode/SKU > exact brand name >
// curated brand-name tag > exact active-ingredient/generic name > same
// medication definition > other.
const MATCH_SCORE: Record<MatchType, number> = {
  sku: 100,
  'name-exact': 90,
  'alias-exact': 88,
  'ingredient-exact': 80,
  'category-keyword-exact': 70,
  'definition-contains': 65,
  'alias-contains': 63,
  'ingredient-contains': 60,
  'name-contains': 55,
  'category-keyword-contains': 50,
};

/**
 * Normalize brand-name search tags (Product.searchAliases) the same way a
 * query is normalized before matching: trim, lowercase, strip accents, dedupe.
 * Storing already-normalized means matching is a plain array-membership check
 * (`{ has: normalizedQuery }`) with no per-element re-normalization needed.
 */
export function normalizeSearchAliases(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = stripAccents(tag.trim().toLowerCase());
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/**
 * Match a normalized query against a product's normalized brand-name tags.
 * `has` in Prisma is exact-membership only, so the DB query can't filter by
 * substring — this runs in JS after a broad `searchAliases: { isEmpty: false }`
 * fetch. Exact tag match ranks above a substring hit within a longer tag
 * (e.g. querying "marca" against a tag "test marca").
 */
export function matchSearchAlias(aliases: string[], normalizedQuery: string): 'alias-exact' | 'alias-contains' | null {
  if (aliases.includes(normalizedQuery)) return 'alias-exact';
  if (aliases.some((a) => a.includes(normalizedQuery))) return 'alias-contains';
  return null;
}

/** Same shape as matchSearchAlias, for Category.symptomKeywords (e.g. "fiebre" -> Analgésicos y antipiréticos). */
export function matchSymptomKeyword(
  keywords: string[],
  normalizedQuery: string,
): 'category-keyword-exact' | 'category-keyword-contains' | null {
  if (keywords.includes(normalizedQuery)) return 'category-keyword-exact';
  if (keywords.some((k) => k.includes(normalizedQuery))) return 'category-keyword-contains';
  return null;
}

/** Dedupe by product id, keeping each product's single best matchType. */
export function dedupeByBestMatch<T extends SearchCandidate>(candidates: T[]): T[] {
  const byId = new Map<string, T>();
  for (const c of candidates) {
    const existing = byId.get(c.id);
    if (!existing || MATCH_SCORE[c.matchType] > MATCH_SCORE[existing.matchType]) {
      byId.set(c.id, c);
    }
  }
  return [...byId.values()];
}

/** Rank: match strength first, then in-stock over out-of-stock, then price. */
export function rankSearchCandidates<T extends SearchCandidate>(candidates: T[]): T[] {
  return dedupeByBestMatch(candidates)
    .filter((c) => !c.isDiscontinued)
    .sort((a, b) => {
      const scoreDiff = MATCH_SCORE[b.matchType] - MATCH_SCORE[a.matchType];
      if (scoreDiff !== 0) return scoreDiff;
      if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
      const priceA = a.price ?? Infinity;
      const priceB = b.price ?? Infinity;
      return priceA - priceB;
    });
}

export function isStrongMatch(candidate: SearchCandidate): boolean {
  return candidate.matchType === 'sku' || candidate.matchType === 'name-exact' || candidate.matchType === 'alias-exact';
}

/**
 * True when the ranked list is unambiguous enough to check for equivalents
 * once we know the top result is out of stock: a strong/exact match, or the
 * sole name match (e.g. searching "Tylenol" against a product literally
 * named "Tylenol 500 mg" — only a `name-contains` hit, but there's nothing
 * else it could mean). Requires a `medicationDefinitionId` too — with none,
 * there's no possible equivalent to look up, so collapsing to just the top
 * result would silently drop every other legitimate match for nothing.
 */
export function shouldShowAlternatives(ranked: SearchCandidate[]): boolean {
  if (ranked.length === 0) return false;
  const top = ranked[0];
  if (!top.medicationDefinitionId) return false;
  const isSoleNameMatch = ranked.length === 1 && top.matchType === 'name-contains';
  return (isStrongMatch(top) || isSoleNameMatch) && !top.inStock;
}

export type SearchResult<T extends SearchCandidate, A> = {
  requested: T[];
  alternatives: A[];
};

/**
 * Split ranked candidates into "requested" vs "alternatives": only when
 * shouldShowAlternatives(ranked) holds do we pull in equivalents. An
 * ambiguous/generic query just returns a flat ranked list with no split.
 */
export function buildSearchResult<T extends SearchCandidate, A>(
  ranked: T[],
  findAlternatives: (product: T) => A[],
): SearchResult<T, A> {
  if (ranked.length === 0) return { requested: [], alternatives: [] };

  if (shouldShowAlternatives(ranked)) {
    return { requested: [ranked[0]], alternatives: findAlternatives(ranked[0]) };
  }
  return { requested: ranked, alternatives: [] };
}

export { rankEquivalents };
