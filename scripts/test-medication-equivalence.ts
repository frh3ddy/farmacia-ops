/**
 * Assert-based self-check for the catalog search / medication equivalence
 * ranking logic (apps/api/src/products/catalog-search.ts and
 * medication-equivalence.ts). No DB, no test framework — these are pure
 * functions, tested directly with in-memory fixtures, same style as the
 * rest of scripts/*.ts.
 *
 * Usage: npx tsx scripts/test-medication-equivalence.ts
 */
import assert from 'node:assert/strict';
import { rankEquivalents } from '../apps/api/src/products/medication-equivalence';
import {
  rankSearchCandidates,
  buildSearchResult,
  type SearchCandidate,
} from '../apps/api/src/products/catalog-search';

// --- Fixtures ---------------------------------------------------------
// Paracetamol 500mg tablet, oral (definition "med-para-500-tab")
const tylenol = { id: 'tylenol', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: false, price: 58 };
const genericA = { id: 'generic-a', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: true, price: 22 };
const genericB = { id: 'generic-b', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: false, inStock: true, price: 18 };
const genericC_discontinued = { id: 'generic-c', medicationDefinitionId: 'med-para-500-tab', isDiscontinued: true, inStock: true, price: 15 };
// Same active ingredient (paracetamol) but different strength -> different definition
const paraSuspension = { id: 'para-susp', medicationDefinitionId: 'med-para-susp', isDiscontinued: false, inStock: true, price: 30 };
// A brand with no equivalents at all
const loneBrand = { id: 'lone-brand', medicationDefinitionId: 'med-lonely', isDiscontinued: false, inStock: false, price: 40 };

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// --- rankEquivalents ----------------------------------------------------

test('branded product out of stock -> generic alternatives found, in-stock-first then cheapest-first', () => {
  const result = rankEquivalents(tylenol, [tylenol, genericA, genericB]);
  assert.deepEqual(result.map((r) => r.id), ['generic-b', 'generic-a']);
});

test('different strength (suspension vs tablet) never treated as equivalent', () => {
  const result = rankEquivalents(tylenol, [tylenol, genericA, paraSuspension]);
  assert.ok(!result.some((r) => r.id === 'para-suspension'));
  assert.deepEqual(result.map((r) => r.id), ['generic-a']);
});

test('discontinued products excluded from alternatives', () => {
  const result = rankEquivalents(tylenol, [tylenol, genericA, genericC_discontinued]);
  assert.ok(!result.some((r) => r.id === 'generic-c'));
});

test('no valid alternatives available -> empty array, not an error', () => {
  const result = rankEquivalents(loneBrand, [loneBrand]);
  assert.deepEqual(result, []);
});

test('non-medication product (no medicationDefinitionId) -> no equivalence concept, empty array', () => {
  const nonMed = { id: 'shampoo', medicationDefinitionId: null, isDiscontinued: false, inStock: false, price: 50 };
  const result = rankEquivalents(nonMed, [nonMed, genericA]);
  assert.deepEqual(result, []);
});

// --- rankSearchCandidates + buildSearchResult ---------------------------

function candidate(base: typeof tylenol, matchType: SearchCandidate['matchType']): SearchCandidate {
  return { ...base, matchType };
}

test('exact branded search, in stock -> brand shown, no alternatives split', () => {
  const inStockBrand = candidate({ ...tylenol, inStock: true }, 'name-exact');
  const ranked = rankSearchCandidates([inStockBrand]);
  const result = buildSearchResult(ranked, () => [genericA, genericB]);
  assert.deepEqual(result.requested.map((r) => r.id), ['tylenol']);
  assert.deepEqual(result.alternatives, []);
});

test('exact branded search, out of stock -> brand shown as unavailable + alternatives populated', () => {
  const outOfStockBrand = candidate(tylenol, 'name-exact');
  const ranked = rankSearchCandidates([outOfStockBrand]);
  const result = buildSearchResult(ranked, () => [genericB, genericA]);
  assert.deepEqual(result.requested.map((r) => r.id), ['tylenol']);
  assert.deepEqual(result.alternatives.map((r) => r.id), ['generic-b', 'generic-a']);
});

test('exact branded search, out of stock, no equivalents -> alternatives is empty, not silently dropped', () => {
  const outOfStockLoneBrand = candidate(loneBrand, 'sku');
  const ranked = rankSearchCandidates([outOfStockLoneBrand]);
  const result = buildSearchResult(ranked, () => []);
  assert.deepEqual(result.requested.map((r) => r.id), ['lone-brand']);
  assert.deepEqual(result.alternatives, []);
});

test('generic/ambiguous query with multiple direct matches -> flat ranked list, no split', () => {
  const candidates = [
    candidate(genericA, 'name-contains'),
    candidate(genericB, 'name-contains'),
    candidate({ ...tylenol, inStock: true }, 'name-contains'),
  ];
  const ranked = rankSearchCandidates(candidates);
  const result = buildSearchResult(ranked, () => {
    throw new Error('should not compute alternatives for an ambiguous query');
  });
  assert.equal(result.requested.length, 3);
  assert.deepEqual(result.alternatives, []);
});

test('SKU exact match outranks everything else', () => {
  const candidates = [candidate(genericA, 'name-exact'), candidate(genericB, 'sku')];
  const ranked = rankSearchCandidates(candidates);
  assert.equal(ranked[0].id, 'generic-b');
});

test('active-ingredient exact match outranks a plain name-contains match', () => {
  const candidates = [candidate(genericA, 'name-contains'), candidate(genericB, 'ingredient-exact')];
  const ranked = rankSearchCandidates(candidates);
  assert.equal(ranked[0].id, 'generic-b');
});

test('in-stock breaks ties over out-of-stock within the same match tier', () => {
  const candidates = [
    candidate({ ...genericA, inStock: false }, 'name-contains'),
    candidate({ ...genericB, inStock: true }, 'name-contains'),
  ];
  const ranked = rankSearchCandidates(candidates);
  assert.equal(ranked[0].id, 'generic-b');
});

test('discontinued products excluded from search results entirely', () => {
  const candidates = [candidate(genericA, 'name-contains'), candidate(genericC_discontinued, 'sku')];
  const ranked = rankSearchCandidates(candidates);
  assert.ok(!ranked.some((r) => r.id === 'generic-c'));
});

test('a product matched via two branches keeps only its single best matchType (dedupe)', () => {
  const candidates = [candidate(genericA, 'name-contains'), candidate(genericA, 'sku')];
  const ranked = rankSearchCandidates(candidates);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].matchType, 'sku');
});

console.log(`\n${passed} assertions passed.`);
