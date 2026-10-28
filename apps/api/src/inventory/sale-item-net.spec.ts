import { Prisma } from '@prisma/client';
import { assert } from 'riteway/vitest';
import { saleItemNet } from './sale-item-net';

const d = (n: number) => new Prisma.Decimal(n);
const plain = (net: ReturnType<typeof saleItemNet>) => [net.units, net.revenue.toString(), net.cost.toString()];

describe('saleItemNet', () => {
  test('returns', () => {
    assert({
      given: '3 units sold at $45 (cost 33) with one unit returned (revenue 45, cost 11)',
      should: 'count what the customer kept',
      actual: plain(saleItemNet({ quantity: 3, price: d(45), cost: d(33), returns: [{ quantity: 1, revenue: d(45), cost: d(11) }] })),
      expected: [2, '90', '22'],
    });
    assert({
      given: 'an item with no returns',
      should: 'count the whole sale',
      actual: plain(saleItemNet({ quantity: 2, price: d(10), cost: d(12), returns: [] })),
      expected: [2, '20', '12'],
    });
  });
});
