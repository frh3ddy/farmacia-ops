import { rankEquivalents } from './medication-equivalence';

// Paracetamol 500mg tablet, oral (definition "med-para-500-tab")
const tylenol = { id: 'tylenol', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: false, price: 58 };
const genericA = { id: 'generic-a', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: true, price: 22 };
const genericB = { id: 'generic-b', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: true, price: 18 };
const genericDiscontinued = { id: 'generic-c', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: true, inStock: true, price: 15 };
// Same active ingredient (paracetamol) but different strength -> different definition
const paraSuspension = { id: 'para-susp', medicationDefinitionId: 'med-para-susp', isDiscontinued: false, inStock: true, price: 30 };
const loneBrand = { id: 'lone-brand', medicationDefinitionId: 'med-lonely', isDiscontinued: false, inStock: false, price: 40 };

describe('rankEquivalents', () => {
  it('finds generic alternatives for an out-of-stock brand, in-stock-first then cheapest-first', () => {
    const result = rankEquivalents(tylenol, [tylenol, genericA, genericB]);
    expect(result.map((r) => r.id)).toEqual(['generic-b', 'generic-a']);
  });

  it('never treats a different strength (suspension vs tablet) as equivalent', () => {
    const result = rankEquivalents(tylenol, [tylenol, genericA, paraSuspension]);
    expect(result.map((r) => r.id)).toEqual(['generic-a']);
  });

  it('excludes discontinued products from alternatives', () => {
    const result = rankEquivalents(tylenol, [tylenol, genericA, genericDiscontinued]);
    expect(result.some((r) => r.id === 'generic-c')).toBe(false);
  });

  it('returns an empty array (not an error) when no valid alternatives exist', () => {
    const result = rankEquivalents(loneBrand, [loneBrand]);
    expect(result).toEqual([]);
  });

  it('returns an empty array for a non-medication product (no medicationDefinitionId)', () => {
    const nonMed = { id: 'shampoo', medicationDefinitionId: null, isDiscontinued: false, inStock: false, price: 50 };
    const result = rankEquivalents(nonMed, [nonMed, genericA]);
    expect(result).toEqual([]);
  });
});
