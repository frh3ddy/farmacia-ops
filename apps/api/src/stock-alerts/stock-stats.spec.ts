import { assert } from 'riteway/vitest';
import { stockStats } from './stock-stats';

/** Two weeks, Nov 1–14: in stock at 3, out on Nov 3, restocked to 5 on Nov 6, out again on Nov 10. */
const twoWeeks = () => ({
  window: { from: '2026-11-01', to: '2026-11-14' },
  levels: [
    { day: '2026-10-20', quantity: 3 },
    { day: '2026-11-03', quantity: 0 },
    { day: '2026-11-06', quantity: 5 },
    { day: '2026-11-10', quantity: 0 },
  ],
  sales: [
    { day: '2026-11-02', quantity: 2 },
    { day: '2026-11-03', quantity: 1 },
    { day: '2026-11-09', quantity: 4 },
    { day: '2026-11-12', quantity: -1 },
  ],
  lastSoldDay: '2026-11-09',
  zeroFrom: '2026-11-10',
});

describe('stockStats()', () => {
  test('a window with sales, stock-outs and a restock', () => {
    assert({
      given: 'stock days and sales in the window',
      should: 'net units of returns, count the weeks with a sale, take the median level on days in stock, and not count a day with a sale as a day at 0',
      actual: stockStats(twoWeeks()),
      expected: { unitsSold: 6, weeksWithSales: 2, typicalOnHand: 5, daysAtZero: 7, stockOuts: 2, zeroSince: '2026-11-10', stockAtEnd: 0 },
    });
  });

  test('selling while the stock says 0', () => {
    const input = {
      window: { from: '2026-11-01', to: '2026-11-14' },
      levels: [{ day: '2026-10-01', quantity: 0 }],
      sales: [{ day: '2026-11-05', quantity: 1 }],
      lastSoldDay: '2026-11-05',
      zeroFrom: '2026-10-01',
    };

    assert({
      given: 'a sale on a day the stock history says 0',
      should: 'start the current run at 0 the day after that sale',
      actual: stockStats(input).zeroSince,
      expected: '2026-11-06',
    });
  });

  test('the last unit sold on the window\'s last day', () => {
    const input = { ...twoWeeks(), sales: [...twoWeeks().sales, { day: '2026-11-14', quantity: 1 }], lastSoldDay: '2026-11-14' };

    assert({
      given: 'a sale on the last day that left the stock at 0',
      should: 'not count that day at 0, and start the run at 0 the day after',
      actual: [stockStats(input).daysAtZero, stockStats(input).zeroSince],
      expected: [6, '2026-11-15'],
    });
  });

  test('in stock at the end of the window', () => {
    const input = { ...twoWeeks(), levels: [...twoWeeks().levels, { day: '2026-11-14', quantity: 4 }] };

    assert({
      given: 'stock above 0 on the window\'s last day',
      should: 'have no run at 0, and end at that stock',
      actual: [stockStats(input).zeroSince, stockStats(input).stockAtEnd],
      expected: [null, 4],
    });
  });

  test('never stocked, never sold', () => {
    const input = { window: { from: '2026-11-01', to: '2026-11-14' }, levels: [], sales: [], lastSoldDay: null, zeroFrom: null };

    assert({
      given: 'no stock history and no sales',
      should: 'count no day at 0, since nothing is known about its stock, and an unknown start of the run at 0',
      actual: stockStats(input),
      expected: { unitsSold: 0, weeksWithSales: 0, typicalOnHand: 0, daysAtZero: 0, stockOuts: 0, zeroSince: null, stockAtEnd: null },
    });
  });

  test('a product first known inside the window', () => {
    const window = { from: '2026-11-01', to: '2026-11-14' };
    const firstStockedAtZero = {
      window,
      levels: [
        { day: '2026-11-04', quantity: 0 },
        { day: '2026-11-06', quantity: 5 },
        { day: '2026-11-10', quantity: 0 },
      ],
      sales: [],
      lastSoldDay: null,
      zeroFrom: '2026-11-10',
    };
    const soldBeforeStocked = {
      window,
      levels: [
        { day: '2026-11-06', quantity: 5 },
        { day: '2026-11-10', quantity: 0 },
      ],
      sales: [{ day: '2026-11-03', quantity: 1 }],
      lastSoldDay: '2026-11-03',
      zeroFrom: '2026-11-10',
    };

    assert({
      given: 'a first stock day at 0 inside the window',
      should: 'count days at 0 from that day, and that first 0 not as a stock-out',
      actual: [stockStats(firstStockedAtZero).daysAtZero, stockStats(firstStockedAtZero).stockOuts],
      expected: [7, 1],
    });

    assert({
      given: 'a sale before the first stock day',
      should: 'still count days at 0 only from the first stock day: a sale proves stock on its own day only',
      actual: [stockStats(soldBeforeStocked).daysAtZero, stockStats(soldBeforeStocked).stockOuts],
      expected: [5, 1],
    });
  });

  test('sold with no stock days', () => {
    const input = {
      window: { from: '2026-11-01', to: '2026-11-14' },
      levels: [],
      sales: [{ day: '2026-11-02', quantity: 1 }, { day: '2026-11-09', quantity: 1 }],
      lastSoldDay: '2026-11-09',
      zeroFrom: null,
    };

    assert({
      given: 'weekly sales and no stock history (stock Square never tracked)',
      should: 'count the sales, but no day at 0, no stock-out, and no run at 0',
      actual: [stockStats(input).unitsSold, stockStats(input).daysAtZero, stockStats(input).stockOuts, stockStats(input).zeroSince],
      expected: [2, 0, 0, null],
    });
  });
});
