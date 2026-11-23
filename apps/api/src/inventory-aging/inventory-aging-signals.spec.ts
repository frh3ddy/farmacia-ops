import { assert } from 'riteway/vitest';
import { Prisma } from '@prisma/client';
import { InventoryAgingService } from './inventory-aging.service';

const D = (n: number) => new Prisma.Decimal(n);
const bucket = (min: number, cash: number) => ({ bucket: { min }, cashValue: D(cash) }) as never;
const product = (o: { age: number; cash: number; units: number; risk: 'HIGH' | 'CRITICAL' | 'LOW' }) => ({
  productId: 'p1', productName: 'Amoxicilina', categoryName: null, totalCashTiedUp: D(o.cash), totalUnits: o.units,
  oldestBatchAge: o.age, bucketDistribution: [bucket(0, 100), bucket(61, o.cash - 100)], riskLevel: o.risk,
});
const signals = (products: unknown[], categories: unknown[] = []) =>
  new InventoryAgingService({} as never).generateActionableSignals(products as never, categories as never, []);

describe('generateActionableSignals codes', () => {
  test('a product at risk', () => {
    const [old] = signals([product({ age: 140, cash: 600, units: 12, risk: 'CRITICAL' })]);
    const [younger] = signals([product({ age: 70, cash: 600, units: 12, risk: 'HIGH' })]);
    assert({
      given: 'products at risk 140 and 70 days old',
      should: 'give action codes and the numbers for the app to write, keeping the old English fields',
      actual: [old.actionCodes, old.days, old.units, younger.actionCodes, typeof old.message, old.recommendedActions.length],
      expected: [['DISCOUNT', 'STOP_REORDER', 'PRICE_REVIEW', 'TRANSFER'], 140, 12, ['PRICE_REVIEW', 'TRANSFER'], 'string', 4],
    });
  });

  test('slow and expensive, and an overstocked category', () => {
    const [slow] = signals([product({ age: 80, cash: 2000, units: 3, risk: 'LOW' })]);
    const [category] = signals([], [{ categoryId: 'c1', categoryName: 'Antibióticos', totalCashTiedUp: D(20000), totalUnits: 400, bucketDistribution: [], averageAge: 52.36 }]);
    assert({
      given: 'a slow, expensive product and a category with too much stock',
      should: 'give each its action codes, days and units',
      actual: [[slow.actionCodes, slow.days, slow.units], [category.actionCodes, category.days, category.units]],
      expected: [
        [['PRICE_REVIEW', 'RENEGOTIATE_SUPPLIER', 'REVIEW_PURCHASING'], 80, 3],
        [['REDUCE_PURCHASING', 'ADJUST_ASSORTMENT', 'REVIEW_CATEGORY'], 52.4, 400],
      ],
    });
  });
});
