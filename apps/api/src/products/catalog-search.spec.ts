import {
  rankSearchCandidates,
  buildSearchResult,
  normalizeSearchAliases,
  matchSearchAlias,
  type SearchCandidate,
} from './catalog-search';

const tylenol = { id: 'tylenol', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: false, price: 58 };
const genericA = { id: 'generic-a', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: true, price: 22 };
const genericB = { id: 'generic-b', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: true, price: 18 };
const genericDiscontinued = { id: 'generic-c', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: true, inStock: true, price: 15 };
const loneBrand = { id: 'lone-brand', medicationDefinitionId: 'med-lonely', isDiscontinued: false, inStock: false, price: 40 };
// A non-medication product (no medicationDefinitionId) — e.g. a plain test/misc product.
const plainA = { id: 'plain-a', medicationDefinitionId: null, isDiscontinued: false, inStock: false, price: 10 };
const plainB = { id: 'plain-b', medicationDefinitionId: null, isDiscontinued: false, inStock: false, price: 12 };

function candidate(base: Omit<SearchCandidate, 'matchType'>, matchType: SearchCandidate['matchType']): SearchCandidate {
  return { ...base, matchType };
}

describe('rankSearchCandidates', () => {
  it('ranks an exact SKU match above everything else', () => {
    const ranked = rankSearchCandidates([candidate(genericA, 'name-exact'), candidate(genericB, 'sku')]);
    expect(ranked[0].id).toBe('generic-b');
  });

  it('ranks an exact active-ingredient match above a plain name-contains match', () => {
    const ranked = rankSearchCandidates([candidate(genericA, 'name-contains'), candidate(genericB, 'ingredient-exact')]);
    expect(ranked[0].id).toBe('generic-b');
  });

  it('breaks ties within the same match tier by in-stock over out-of-stock', () => {
    const ranked = rankSearchCandidates([
      candidate({ ...genericA, inStock: false }, 'name-contains'),
      candidate({ ...genericB, inStock: true }, 'name-contains'),
    ]);
    expect(ranked[0].id).toBe('generic-b');
  });

  it('excludes discontinued products entirely', () => {
    const ranked = rankSearchCandidates([candidate(genericA, 'name-contains'), candidate(genericDiscontinued, 'sku')]);
    expect(ranked.some((r) => r.id === 'generic-c')).toBe(false);
  });

  it('dedupes a product matched via multiple branches, keeping its single best matchType', () => {
    const ranked = rankSearchCandidates([candidate(genericA, 'name-contains'), candidate(genericA, 'sku')]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].matchType).toBe('sku');
  });
});

describe('buildSearchResult', () => {
  it('shows the brand with no alternatives split when it is in stock', () => {
    const inStockBrand = candidate({ ...tylenol, inStock: true }, 'name-exact');
    const ranked = rankSearchCandidates([inStockBrand]);
    const result = buildSearchResult(ranked, () => [genericA, genericB]);
    expect(result.requested.map((r) => r.id)).toEqual(['tylenol']);
    expect(result.alternatives).toEqual([]);
  });

  it('shows the brand as unavailable and populates alternatives when it is out of stock', () => {
    const ranked = rankSearchCandidates([candidate(tylenol, 'name-exact')]);
    const result = buildSearchResult(ranked, () => [genericB, genericA]);
    expect(result.requested.map((r) => r.id)).toEqual(['tylenol']);
    expect(result.alternatives.map((r) => r.id)).toEqual(['generic-b', 'generic-a']);
  });

  it('does not silently drop the case where an out-of-stock brand has no alternatives', () => {
    const ranked = rankSearchCandidates([candidate(loneBrand, 'sku')]);
    const result = buildSearchResult(ranked, () => []);
    expect(result.requested.map((r) => r.id)).toEqual(['lone-brand']);
    expect(result.alternatives).toEqual([]);
  });

  it('returns a flat ranked list with no split for an ambiguous/generic query', () => {
    const ranked = rankSearchCandidates([
      candidate(genericA, 'name-contains'),
      candidate(genericB, 'name-contains'),
      candidate({ ...tylenol, inStock: true }, 'name-contains'),
    ]);
    const result = buildSearchResult(ranked, () => {
      throw new Error('should not compute alternatives for an ambiguous query');
    });
    expect(result.requested).toHaveLength(3);
    expect(result.alternatives).toEqual([]);
  });

  it('checks alternatives for a sole partial brand-name match that is out of stock (e.g. "Tylenol" vs "Tylenol 500 mg")', () => {
    const ranked = rankSearchCandidates([candidate(tylenol, 'name-contains')]);
    const result = buildSearchResult(ranked, () => [genericB, genericA]);
    expect(result.requested.map((r) => r.id)).toEqual(['tylenol']);
    expect(result.alternatives.map((r) => r.id)).toEqual(['generic-b', 'generic-a']);
  });

  it('does not split for a sole partial name match that is in stock', () => {
    const ranked = rankSearchCandidates([candidate({ ...tylenol, inStock: true }, 'name-contains')]);
    const result = buildSearchResult(ranked, () => {
      throw new Error('should not compute alternatives when in stock');
    });
    expect(result.requested.map((r) => r.id)).toEqual(['tylenol']);
  });

  it('surfaces a generic directly via a curated brand-name tag, with no branded product involved at all', () => {
    // e.g. genericA (a real product) tagged with "advil" — no "Advil" product row exists anywhere.
    const ranked = rankSearchCandidates([candidate(genericA, 'alias-exact')]);
    const result = buildSearchResult(ranked, () => {
      throw new Error('in stock — should not compute alternatives');
    });
    expect(result.requested.map((r) => r.id)).toEqual(['generic-a']);
  });

  it('checks alternatives for an alias-tag match when the tagged product is out of stock', () => {
    const ranked = rankSearchCandidates([candidate({ ...genericA, inStock: false }, 'alias-exact')]);
    const result = buildSearchResult(ranked, () => [genericB]);
    expect(result.requested.map((r) => r.id)).toEqual(['generic-a']);
    expect(result.alternatives.map((r) => r.id)).toEqual(['generic-b']);
  });

  it('does not collapse to a single result when the out-of-stock exact match has no medicationDefinitionId (e.g. two non-medication test products)', () => {
    // Regression: searching "test" against products "test" (exact, no def, out of stock)
    // and "test generic" (contains, out of stock) used to drop "test generic" entirely,
    // since there's no medicationDefinitionId to look up any equivalent for.
    const ranked = rankSearchCandidates([candidate(plainA, 'name-exact'), candidate(plainB, 'name-contains')]);
    const result = buildSearchResult(ranked, () => {
      throw new Error('no medicationDefinitionId — should never attempt to compute alternatives');
    });
    expect(result.requested.map((r) => r.id)).toEqual(['plain-a', 'plain-b']);
    expect(result.alternatives).toEqual([]);
  });
});

describe('matchSearchAlias', () => {
  it('returns alias-exact for a whole-tag match', () => {
    expect(matchSearchAlias(['tylenol', 'panadol'], 'tylenol')).toBe('alias-exact');
  });

  it('returns alias-contains for a substring hit within a longer tag (e.g. "marca" within "test marca")', () => {
    expect(matchSearchAlias(['test marca', 'test marca 2'], 'marca')).toBe('alias-contains');
  });

  it('prefers alias-exact over alias-contains when both would match', () => {
    expect(matchSearchAlias(['marca', 'test marca'], 'marca')).toBe('alias-exact');
  });

  it('returns null when no tag matches at all', () => {
    expect(matchSearchAlias(['tylenol'], 'panadol')).toBeNull();
  });
});

describe('normalizeSearchAliases', () => {
  it('trims, lowercases, and strips accents', () => {
    expect(normalizeSearchAliases([' Tylenol ', 'PANADOL', 'Acetaminofén'])).toEqual([
      'tylenol',
      'panadol',
      'acetaminofen',
    ]);
  });

  it('dedupes tags that normalize to the same value', () => {
    expect(normalizeSearchAliases(['Tylenol', 'tylenol', ' TYLENOL '])).toEqual(['tylenol']);
  });

  it('drops empty/whitespace-only tags', () => {
    expect(normalizeSearchAliases(['Tylenol', '   ', ''])).toEqual(['tylenol']);
  });
});
