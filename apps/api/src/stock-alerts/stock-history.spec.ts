/**
 * Rebuilding past stock levels from Square's inventory changes (before the
 * cutover): which change moves stock at which store, which ones are restocks,
 * and the end-of-day level they add up to.
 */
import { assert } from 'riteway/vitest';
import type { Square } from 'square';
import { isUnreadable, mergeDays, replayStock, stockEvents } from './stock-history';

const adjustment = (a: Partial<Square.InventoryAdjustment>): Square.InventoryChange => ({
  type: 'ADJUSTMENT',
  adjustment: { catalogObjectId: 'VAR', fromLocationId: 'SQ-C', toLocationId: 'SQ-C', occurredAt: '2026-03-02T18:00:00Z', ...a },
});
const count = (quantity: string, occurredAt: string): Square.InventoryChange => ({
  type: 'PHYSICAL_COUNT',
  physicalCount: { catalogObjectId: 'VAR', locationId: 'SQ-C', state: 'IN_STOCK', quantity, occurredAt },
});
const replay = (changes: Square.InventoryChange[]) => replayStock(changes.flatMap(stockEvents));

describe('stockEvents()', () => {
  test('kinds of change', () => {
    assert({
      given: 'a receiving, a sale, a return to the shelf and a refund to waste',
      should: 'add the receiving as a restock, take off the sale, add the return without a restock, and ignore the waste refund',
      actual: [
        adjustment({ fromState: 'NONE', toState: 'IN_STOCK', quantity: '5' }),
        adjustment({ fromState: 'IN_STOCK', toState: 'SOLD', quantity: '2' }),
        adjustment({ fromState: 'SOLD', toState: 'IN_STOCK', quantity: '1', refundId: 'R' }),
        adjustment({ fromState: 'SOLD', toState: 'WASTE', quantity: '1', refundId: 'R' }),
      ].flatMap(stockEvents).map((e) => [e.kind, e.quantity, e.restock]),
      expected: [['delta', 5, true], ['delta', -2, false], ['delta', 1, false]],
    });
  });

  test('a transfer between stores', () => {
    assert({
      given: 'a move from IN_STOCK at one store to IN_STOCK at another (the app\'s transfer push)',
      should: 'take the units off the first store and restock them at the second',
      actual: stockEvents(adjustment({ fromState: 'IN_STOCK', toState: 'IN_STOCK', fromLocationId: 'SQ-C', toLocationId: 'SQ-O', quantity: '3' }))
        .map((e) => [e.locationSquareId, e.quantity, e.restock]),
      expected: [['SQ-C', -3, false], ['SQ-O', 3, true]],
    });
  });

  test('a count of something other than IN_STOCK', () => {
    assert({
      given: 'a physical count of the WASTE state',
      should: 'not touch stock',
      actual: stockEvents({ type: 'PHYSICAL_COUNT', physicalCount: { ...count('4', '2026-03-02T18:00:00Z').physicalCount, state: 'WASTE' } }),
      expected: [],
    });
  });
});

describe('isUnreadable()', () => {
  test('changes the replay can\'t place', () => {
    assert({
      given: 'an adjustment without store ids, a count without a store, an unknown change type, a sale and a refund to waste',
      should: 'flag the first three and not the ones that are understood',
      actual: ([
        adjustment({ fromState: 'IN_STOCK', toState: 'SOLD', quantity: '1', fromLocationId: null, toLocationId: null }),
        { type: 'PHYSICAL_COUNT', physicalCount: { ...count('3', '2026-03-02T18:00:00Z').physicalCount, locationId: null } },
        { type: 'TRANSFER' } as unknown as Square.InventoryChange,
        adjustment({ fromState: 'IN_STOCK', toState: 'SOLD', quantity: '1' }),
        adjustment({ fromState: 'SOLD', toState: 'WASTE', quantity: '1', refundId: 'R' }),
      ] as Square.InventoryChange[]).map(isUnreadable),
      expected: [true, true, true, false, false],
    });
  });
});

describe('replayStock()', () => {
  test('a day with several changes', () => {
    assert({
      given: 'a receiving and a sale on one day, and another sale the next',
      should: 'give one row per day with its end-of-day stock, the first one a restock',
      actual: replay([
        adjustment({ fromState: 'NONE', toState: 'IN_STOCK', quantity: '5', occurredAt: '2026-03-02T15:00:00Z' }),
        adjustment({ fromState: 'IN_STOCK', toState: 'SOLD', quantity: '2', occurredAt: '2026-03-02T20:00:00Z' }),
        adjustment({ fromState: 'IN_STOCK', toState: 'SOLD', quantity: '1', occurredAt: '2026-03-03T20:00:00Z' }),
      ]),
      expected: {
        days: [
          { day: '2026-03-02', quantity: 3, restocked: true },
          { day: '2026-03-03', quantity: 2, restocked: false },
        ],
        final: 2,
      },
    });
  });

  test('recounts', () => {
    assert({
      given: 'a recount above the replayed stock (a receiving entered as a count), then one below it',
      should: 'jump to each count, the one above the replay a restock and the one below a correction',
      actual: replay([
        adjustment({ fromState: 'NONE', toState: 'IN_STOCK', quantity: '2', occurredAt: '2026-03-01T18:00:00Z' }),
        count('10', '2026-03-02T18:00:00Z'),
        count('7', '2026-03-03T18:00:00Z'),
      ]).days,
      expected: [
        { day: '2026-03-01', quantity: 2, restocked: true },
        { day: '2026-03-02', quantity: 10, restocked: true },
        { day: '2026-03-03', quantity: 7, restocked: false },
      ],
    });
  });

  test('a recount that matches', () => {
    assert({
      given: 'a recount equal to the replayed stock',
      should: 'keep the level without a restock',
      actual: replay([
        adjustment({ fromState: 'NONE', toState: 'IN_STOCK', quantity: '4', occurredAt: '2026-03-01T18:00:00Z' }),
        count('4', '2026-03-02T18:00:00Z'),
      ]).days[1],
      expected: { day: '2026-03-02', quantity: 4, restocked: false },
    });
  });

  test('a sale with no recorded stock', () => {
    assert({
      given: 'a sale of more than the replayed stock, then a receiving',
      should: 'stop at 0 (the units came from an unrecorded restock) and add the receiving from there',
      actual: replay([
        adjustment({ fromState: 'NONE', toState: 'IN_STOCK', quantity: '1', occurredAt: '2026-03-01T18:00:00Z' }),
        adjustment({ fromState: 'IN_STOCK', toState: 'SOLD', quantity: '3', occurredAt: '2026-03-02T18:00:00Z' }),
        adjustment({ fromState: 'NONE', toState: 'IN_STOCK', quantity: '2', occurredAt: '2026-03-03T18:00:00Z' }),
      ]).days.map((d) => d.quantity),
      expected: [1, 0, 2],
    });
  });

  test('a negative count', () => {
    assert({
      given: 'a physical count below 0',
      should: 'stop at 0',
      actual: replay([count('-2', '2026-03-02T18:00:00Z')]).final,
      expected: 0,
    });
  });

  test('store clock and order', () => {
    assert({
      given: 'a sale at 02:00 UTC (the evening before on the store clock) listed before the receiving it followed',
      should: 'replay in time order and put both on the store day',
      actual: replay([
        adjustment({ fromState: 'IN_STOCK', toState: 'SOLD', quantity: '1', occurredAt: '2026-03-03T02:00:00Z' }),
        adjustment({ fromState: 'NONE', toState: 'IN_STOCK', quantity: '4', occurredAt: '2026-03-02T23:00:00Z' }),
      ]).days,
      expected: [{ day: '2026-03-02', quantity: 3, restocked: true }],
    });
  });
});

describe('mergeDays()', () => {
  test('two Square items of one product', () => {
    assert({
      given: 'two Square items of one product changing on different days, one of them restocked',
      should: 'add up the levels in force each day',
      actual: mergeDays([
        [{ day: '2026-03-01', quantity: 3, restocked: true }, { day: '2026-03-03', quantity: 1, restocked: false }],
        [{ day: '2026-03-02', quantity: 2, restocked: true }],
      ]),
      expected: [
        { day: '2026-03-01', quantity: 3, restocked: true },
        { day: '2026-03-02', quantity: 5, restocked: true },
        { day: '2026-03-03', quantity: 3, restocked: false },
      ],
    });
  });
});
