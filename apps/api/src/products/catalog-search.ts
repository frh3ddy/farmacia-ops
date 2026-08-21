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

export type SearchResult<T extends SearchCandidate, A> = {
  requested: T[];
  alternatives: A[];
};

/**
 * Split ranked candidates into "requested" vs "alternatives": only when the
 * single best match is a strong/exact one (SKU or exact name — i.e. the
 * shopper searched for one specific product) AND it's out of stock do we
 * pull in equivalents. An ambiguous/generic query just returns a flat
 * ranked list with no split.
 */
export function buildSearchResult<T extends SearchCandidate, A>(
  ranked: T[],
  findAlternatives: (product: T) => A[],
): SearchResult<T, A> {
  if (ranked.length === 0) return { requested: [], alternatives: [] };

  const top = ranked[0];
  if (isStrongMatch(top) && !top.inStock) {
    return { requested: [top], alternatives: findAlternatives(top) };
  }
  return { requested: ranked, alternatives: [] };
}

export { rankEquivalents };
