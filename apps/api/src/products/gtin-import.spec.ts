import { assert } from 'riteway/vitest';
import { planGtinImport } from './gtin-import';

const upcs = new Map(Object.entries({ 'VAR-A': '3664798067460', 'VAR-B': '3664798067460', 'VAR-C': '7501001234567', 'VAR-BLANK': '  ' }));

describe('planGtinImport', () => {
  test('a product whose variations agree', () => {
    assert({
      given: 'a product mapped to two Square variations carrying the same barcode',
      should: 'save that barcode',
      actual: planGtinImport([{ id: 'p1', gtin: null, variationIds: ['VAR-A', 'VAR-B'] }], upcs).updates,
      expected: [{ productId: 'p1', gtin: '3664798067460' }],
    });
  });

  test('a product whose variations disagree', () => {
    const plan = planGtinImport([{ id: 'p1', gtin: null, variationIds: ['VAR-A', 'VAR-C'] }], upcs);

    assert({
      given: 'a product mapped to variations carrying different barcodes',
      should: 'leave it empty and list it with both barcodes',
      actual: [plan.updates, plan.conflicts],
      expected: [[], [{ productId: 'p1', upcs: ['3664798067460', '7501001234567'] }]],
    });
  });

  test('products with nothing to import', () => {
    const plan = planGtinImport(
      [
        { id: 'has', gtin: '111', variationIds: ['VAR-C'] },
        { id: 'blank', gtin: null, variationIds: ['VAR-BLANK', 'VAR-MISSING'] },
      ],
      upcs,
    );

    assert({
      given: 'a product that already has a barcode, and one whose variations have none or are gone from Square',
      should: 'change neither',
      actual: [plan.updates, plan.conflicts],
      expected: [[], []],
    });
  });
});
