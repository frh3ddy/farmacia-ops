import { assert } from 'riteway/vitest';
import { Prisma } from '@prisma/client';
import { businessDay, daysUntilExpiry, expiryDayStart, parseBusinessDate, parseDateParam } from './business-date';
import { InventoryReportsService } from './inventory-reports.service';

describe('parseBusinessDate', () => {
  test('a date-only day', () => {
    assert({
      given: '2026-10-28 as the start, noon and end of a day',
      should: 'mean that day in Mexico City (UTC−6)',
      actual: (['start', 'noon', 'end'] as const).map((at) => parseBusinessDate('2026-10-28', at).toISOString()),
      expected: ['2026-10-28T06:00:00.000Z', '2026-10-28T18:00:00.000Z', '2026-10-29T05:59:59.999Z'],
    });
    assert({
      given: 'a full ISO timestamp',
      should: 'take it as-is',
      actual: parseBusinessDate('2026-10-28T15:30:00Z', 'end').toISOString(),
      expected: '2026-10-28T15:30:00.000Z',
    });
  });
});

describe('parseDateParam', () => {
  test('a value that is not a date', () => {
    assert({
      given: 'endDate=garbage',
      should: 'answer 400 naming the parameter',
      actual: (() => { try { parseDateParam('garbage', 'endDate', 'end'); } catch (e: any) { return [e.status, e.response.message]; } })(),
      expected: [400, 'Invalid endDate format'],
    });
  });
});

describe('businessDay', () => {
  test('an evening sale', () => {
    assert({
      given: '8 pm on Oct 28 in Mexico City (02:00 UTC on Oct 29)',
      should: 'fall on Oct 28',
      actual: businessDay(new Date('2026-10-29T02:00:00Z')),
      expected: '2026-10-28',
    });
  });

  test("the margin report's daily trend", async () => {
    const item = { productId: 'p1', product: { name: 'P' }, quantity: 1, price: new Prisma.Decimal(10), cost: new Prisma.Decimal(4), returns: [] };
    const prisma = { sale: { findMany: vi.fn().mockResolvedValue([{ createdAt: new Date('2026-10-29T02:00:00Z'), items: [item] }]) } };

    const { trends } = await new InventoryReportsService(prisma as any).getProfitMarginReport({});

    assert({
      given: 'a sale at 8 pm Mexico City time',
      should: 'count on that day, not the next',
      actual: trends.map((t) => t.date),
      expected: ['2026-10-28'],
    });
  });
});

describe('daysUntilExpiry', () => {
  const evening = new Date('2026-11-14T20:00:00-06:00'); // already Nov 15 in UTC

  test('the evening before the expiry day', () => {
    assert({
      given: 'a Nov 15 lot stored as legacy UTC midnight or as Mexico City noon, at 8pm on Nov 14',
      should: 'be 1 day away, not expired',
      actual: ['2026-11-15T00:00:00Z', '2026-11-15T18:00:00Z'].map((s) => daysUntilExpiry(new Date(s), evening)),
      expected: [1, 1],
    });
  });

  test('calendar days, not 24h blocks', () => {
    assert({
      given: 'a Nov 15 lot at 12:10am Nov 15, 11pm Nov 13 and 9am Nov 20 (Mexico City)',
      should: 'be 0 on the day, 2 before, -5 after',
      actual: ['2026-11-15T00:10:00-06:00', '2026-11-13T23:00:00-06:00', '2026-11-20T09:00:00-06:00'].map((now) =>
        daysUntilExpiry(new Date('2026-11-15T18:00:00Z'), new Date(now)),
      ),
      expected: [0, 2, -5],
    });
  });
});

describe('expiryDayStart', () => {
  test('query bounds for expiry days', () => {
    const evening = new Date('2026-11-14T20:00:00-06:00');
    assert({
      given: '8pm Nov 14 in Mexico City, 1 and 91 days ahead',
      should: 'be UTC midnight of Nov 15 and Feb 13 (bounds that hold both stored forms)',
      actual: [1, 91].map((n) => expiryDayStart(n, evening).toISOString()),
      expected: ['2026-11-15T00:00:00.000Z', '2027-02-13T00:00:00.000Z'],
    });
  });
});
