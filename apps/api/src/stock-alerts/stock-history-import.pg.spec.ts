/**
 * The one-time stock history rebuild: Square's inventory changes before each
 * store's cutover, the app's movements after, and the report the owner reads
 * before anything is saved (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import type { Square } from 'square';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { importStockHistory } from './stock-history-import';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let ibuprofeno: string;
let paracetamol: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-C', name: 'Centro' } }));
  ({ id: paracetamol } = await prisma.product.create({ data: { name: 'Paracetamol' } }));
  ({ id: ibuprofeno } = await prisma.product.create({ data: { name: 'Ibuprofeno' } }));
  await prisma.catalogMapping.createMany({
    data: [
      { squareVariationId: 'VAR-P', productId: paracetamol, locationId: centro },
      { squareVariationId: 'VAR-I', productId: ibuprofeno, locationId: centro },
    ],
  });
  await prisma.cutoverLock.create({ data: { locationId: centro, cutoverDate: new Date('2026-11-08T12:00:00Z'), isLocked: true } });
  // On hand since the cutover: 4 of Paracetamol, none of Ibuprofeno.
  await prisma.inventory.create({
    data: { productId: paracetamol, locationId: centro, quantity: 4, unitCost: 10, receivedAt: new Date('2026-01-01'), createdAt: new Date('2026-11-08T12:00:00Z') },
  });
}, 120_000);

afterAll(() => stop?.());

beforeEach(() => prisma.stockDay.deleteMany());

const move = (variation: string, from: string, to: string, quantity: string, occurredAt: string): Square.InventoryChange => ({
  type: 'ADJUSTMENT',
  adjustment: { catalogObjectId: variation, fromState: from as Square.InventoryState, toState: to as Square.InventoryState, fromLocationId: 'SQ-C', toLocationId: 'SQ-C', quantity, occurredAt },
});

/** Square: Paracetamol received 6 and sold 2 (ends at 4, as Square counts); Ibuprofeno received 3 and Square counts 1. */
const square = {
  inventory: {
    batchGetChanges: async () => [
      move('VAR-P', 'NONE', 'IN_STOCK', '6', '2026-11-01T18:00:00Z'),
      move('VAR-P', 'IN_STOCK', 'SOLD', '2', '2026-11-02T18:00:00Z'),
      move('VAR-I', 'NONE', 'IN_STOCK', '3', '2026-11-01T18:00:00Z'),
      move('VAR-GONE', 'NONE', 'IN_STOCK', '9', '2026-11-01T18:00:00Z'),
      { type: 'ADJUSTMENT', adjustment: { catalogObjectId: 'VAR-P', fromState: 'IN_STOCK', toState: 'SOLD', quantity: '1', occurredAt: '2026-11-03T18:00:00Z' } },
    ],
    batchGetCounts: async () => [
      { catalogObjectId: 'VAR-P', locationId: 'SQ-C', state: 'IN_STOCK', quantity: '4' },
      { catalogObjectId: 'VAR-I', locationId: 'SQ-C', state: 'IN_STOCK', quantity: '1' },
    ],
  },
} as never;

const now = new Date('2026-11-10T18:00:00Z');

describe('importStockHistory()', () => {
  test('dry run', async () => {
    const r = await importStockHistory(prisma, square, { save: false, now });

    assert({
      given: 'one item whose replay ends at Square\'s count, one that doesn\'t, and one without a product',
      should: 'report half matching, the mismatch first, the item without a product apart, the change without a store, and save nothing',
      actual: [r.stores, r.unreadable, await prisma.stockDay.count()],
      expected: [
        [{
          store: 'Centro',
          cutoverDay: '2026-11-08',
          items: 2,
          matching: 1,
          matchingShare: 0.5,
          worst: [{ variationId: 'VAR-I', product: 'Ibuprofeno', replay: 3, square: 1, difference: 2 }],
          unmapped: 1,
        }],
        { total: 1, byType: { ADJUSTMENT: 1 } },
        0,
      ],
    });
  });

  test('saved', async () => {
    await importStockHistory(prisma, square, { save: true, now });
    const rows = await prisma.stockDay.findMany({ orderBy: [{ productId: 'asc' }, { day: 'asc' }], include: { product: { select: { name: true } } } });

    assert({
      given: 'Square changes before the cutover and app stock after it',
      should: 'store Square\'s days before the cutover day, then the app\'s from it, without repeating an unchanged level',
      actual: rows.map((r) => [r.product.name, r.day.toISOString().slice(0, 10), r.quantity, r.restocked]).sort(),
      expected: [
        ['Ibuprofeno', '2026-11-01', 3, true],
        ['Ibuprofeno', '2026-11-08', 0, false],
        ['Paracetamol', '2026-11-01', 6, true],
        ['Paracetamol', '2026-11-02', 4, false],
      ],
    });
  });
});

describe('importStockHistory() before a cutover', () => {
  test('a store not cut over yet', async () => {
    const { id: norte } = await prisma.location.create({ data: { squareId: 'SQ-N', name: 'Norte' } });
    await prisma.catalogMapping.create({ data: { squareVariationId: 'VAR-N', productId: paracetamol, locationId: norte } });
    const changes = [
      { type: 'ADJUSTMENT', adjustment: { catalogObjectId: 'VAR-N', fromState: 'NONE', toState: 'IN_STOCK', fromLocationId: 'SQ-N', toLocationId: 'SQ-N', quantity: '5', occurredAt: '2026-11-09T18:00:00Z' } },
    ];
    const client = { inventory: { batchGetChanges: async () => changes, batchGetCounts: async () => [] } } as never;

    const r = await importStockHistory(prisma, client, { save: true, now });
    const rows = await prisma.stockDay.findMany({ where: { locationId: norte } });
    await prisma.stockDay.deleteMany({ where: { locationId: norte } });
    await prisma.catalogMapping.deleteMany({ where: { locationId: norte } });
    await prisma.location.delete({ where: { id: norte } });

    assert({
      given: 'a store with Square changes and no cutover',
      should: 'keep its Square days up to today, with no app days after them',
      actual: [r.stores.find((s) => s.store === 'Norte')?.cutoverDay, rows.map((x) => [x.day.toISOString().slice(0, 10), x.quantity, x.restocked])],
      expected: [null, [['2026-11-09', 5, true]]],
    });
  });
});

