/**
 * Pure search ranking/grouping logic — data in, results out, no DB access,
 * so it's directly unit-testable (see scripts/test-medication-equivalence.ts).
 * catalog-search.service.ts gathers candidates from Prisma, tags each with a
 * matchType, and hands them to this module.
 */
import { rankEquivalents, type EquivalenceCandidate } from './medication-equivalence';

export type MatchType =
  | 'sku'
  | 'name-exact'
  | 'ingredient-exact'
  | 'definition-contains'
  | 'ingredient-contains'
  | 'name-contains';

export type SearchCandidate = EquivalenceCandidate & {
  matchType: MatchType;
};

// Priority order from the spec: exact barcode/SKU > exact brand name >
// exact active-ingredient/generic name > same medication definition > other.
const MATCH_SCORE: Record<MatchType, number> = {
  sku: 100,
  'name-exact': 90,
  'ingredient-exact': 80,
  'definition-contains': 65,
  'ingredient-contains': 60,
  'name-contains': 55,
};

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
  return candidate.matchType === 'sku' || candidate.matchType === 'name-exact';
}

/**
 * True when the ranked list is unambiguous enough to check for equivalents
 * once we know the top result is out of stock: a strong/exact match, or the
 * sole name match (e.g. searching "Tylenol" against a product literally
 * named "Tylenol 500 mg" — only a `name-contains` hit, but there's nothing
 * else it could mean).
 */
export function shouldShowAlternatives(ranked: SearchCandidate[]): boolean {
  if (ranked.length === 0) return false;
  const top = ranked[0];
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
