import { rankSearchCandidates, buildSearchResult, type SearchCandidate } from './catalog-search';

const tylenol = { id: 'tylenol', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: false, price: 58 };
const genericA = { id: 'generic-a', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: true, price: 22 };
const genericB = { id: 'generic-b', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: true, price: 18 };
const genericDiscontinued = { id: 'generic-c', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: true, inStock: true, price: 15 };
const loneBrand = { id: 'lone-brand', medicationDefinitionId: 'med-lonely', isDiscontinued: false, inStock: false, price: 40 };

function candidate(base: typeof tylenol, matchType: SearchCandidate['matchType']): SearchCandidate {
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
});
