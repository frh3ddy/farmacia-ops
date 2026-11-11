/**
 * End-of-day stock after the cutover, from the app's own movements, and the
 * nightly job that stores it (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { appStockDays, recordStockDays } from './stock-days';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let oriente: string;
let product: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-C', name: 'Centro' } }));
  ({ id: oriente } = await prisma.location.create({ data: { squareId: 'SQ-O', name: 'Oriente' } }));
  ({ id: product } = await prisma.product.create({ data: { name: 'Paracetamol' } }));
}, 120_000);

afterAll(() => stop?.());

beforeEach(async () => {
  await prisma.stockDay.deleteMany();
  await prisma.transferLine.deleteMany();
  await prisma.transfer.deleteMany();
  await prisma.inventoryConsumption.deleteMany();
  await prisma.inventoryReceiving.deleteMany();
  await prisma.inventoryAdjustment.deleteMany();
  await prisma.inventory.deleteMany();
});

const at = (iso: string) => new Date(iso);

/**
 * Opened at the cutover with 10 (Nov 8); received 5 on Nov 9; sold 3 and wrote
 * off 2 on Nov 10, both from the opening batch. On hand now: 10.
 */
async function movements() {
  const opening = await prisma.inventory.create({
    data: { productId: product, locationId: centro, quantity: 5, unitCost: 10, receivedAt: at('2026-01-01'), source: 'OPENING_BALANCE', createdAt: at('2026-11-08T15:00:00Z') },
  });
  const received = await prisma.inventory.create({
    data: { productId: product, locationId: centro, quantity: 5, unitCost: 10, receivedAt: at('2026-11-09T17:00:00Z'), source: 'PURCHASE', createdAt: at('2026-11-09T17:00:00Z') },
  });
  await prisma.inventoryReceiving.create({
    data: { productId: product, locationId: centro, quantity: 5, unitCost: 10, totalCost: 50, inventoryBatchId: received.id, receivedAt: at('2026-11-09T17:00:00Z') },
  });
  await prisma.inventoryConsumption.createMany({
    data: [
      { inventoryId: opening.id, quantity: 3, unitCost: 10, totalCost: 30, consumedAt: at('2026-11-10T16:00:00Z') },
      { inventoryId: opening.id, quantity: 2, unitCost: 10, totalCost: 20, consumedAt: at('2026-11-10T17:00:00Z') },
    ],
  });
}

describe('appStockDays()', () => {
  test('days since the cutover', async () => {
    await movements();
    const days = await appStockDays(prisma, centro, '2026-11-08');

    assert({
      given: 'opening stock, a receiving and removals on later days',
      should: 'walk back from what is on hand: the first day, then each day with a movement, the receiving a restock',
      actual: days.get(product),
      expected: [
        { day: '2026-11-08', quantity: 10, restocked: false },
        { day: '2026-11-09', quantity: 15, restocked: true },
        { day: '2026-11-10', quantity: 10, restocked: false },
      ],
    });
  });

  test('a found unit is not a restock', async () => {
    const found = await prisma.inventory.create({
      data: { productId: product, locationId: centro, quantity: 1, unitCost: 10, receivedAt: at('2026-11-09T17:00:00Z'), source: 'ADJUSTMENT', createdAt: at('2026-11-09T17:00:00Z') },
    });
    await prisma.inventoryAdjustment.create({
      data: { productId: product, locationId: centro, type: 'FOUND', quantity: 1, unitCost: 10, totalCost: 10, createdBatchId: found.id, adjustedAt: at('2026-11-09T17:00:00Z') },
    });

    assert({
      given: 'a positive adjustment (Encontrado)',
      should: 'add the unit without a restock',
      actual: (await appStockDays(prisma, centro, '2026-11-08')).get(product),
      expected: [
        { day: '2026-11-08', quantity: 0, restocked: false },
        { day: '2026-11-09', quantity: 1, restocked: false },
      ],
    });
  });

  test('stock that came in with no movement record', async () => {
    // A product created in the app with its initial stock (or a store's cutover opening batch): no receiving, transfer or adjustment.
    await prisma.inventory.create({
      data: { productId: product, locationId: centro, quantity: 6, unitCost: 10, receivedAt: at('2026-11-09T17:00:00Z'), source: 'OPENING_BALANCE', createdAt: at('2026-11-09T17:00:00Z') },
    });

    assert({
      given: 'a batch created after the first day without a receiving, transfer or adjustment',
      should: 'count it from the day it was created, not as already on hand, and not as a restock',
      actual: (await appStockDays(prisma, centro, '2026-11-08')).get(product),
      expected: [
        { day: '2026-11-08', quantity: 0, restocked: false },
        { day: '2026-11-09', quantity: 6, restocked: false },
      ],
    });
  });

  test('a received transfer is a restock', async () => {
    const source = await prisma.inventory.create({ data: { productId: product, locationId: oriente, quantity: 0, unitCost: 10, receivedAt: at('2026-10-01') } });
    const arrived = await prisma.inventory.create({
      data: { productId: product, locationId: centro, quantity: 2, unitCost: 10, receivedAt: at('2026-10-01'), createdAt: at('2026-11-09T17:00:00Z') },
    });
    const transfer = await prisma.transfer.create({
      data: { productId: product, fromLocationId: oriente, toLocationId: centro, quantity: 2, status: 'RECEIVED', receivedAt: at('2026-11-09T17:00:00Z') },
    });
    await prisma.transferLine.create({
      data: { transferId: transfer.id, sourceInventoryId: source.id, quantity: 2, quantityReceived: 2, unitCost: 10, originalReceivedAt: at('2026-10-01'), destinationInventoryId: arrived.id },
    });

    assert({
      given: 'units received from another store',
      should: 'add them as a restock at the receiving store',
      actual: (await appStockDays(prisma, centro, '2026-11-08')).get(product),
      expected: [
        { day: '2026-11-08', quantity: 0, restocked: false },
        { day: '2026-11-09', quantity: 2, restocked: true },
      ],
    });
  });
});

describe('recordStockDays()', () => {
  test('nightly', async () => {
    await movements();
    await recordStockDays(prisma, at('2026-11-10T09:00:00Z')); // 03:00 on Nov 10: stores Nov 9
    await recordStockDays(prisma, at('2026-11-11T09:00:00Z')); // stores Nov 10
    await recordStockDays(prisma, at('2026-11-12T09:00:00Z')); // nothing moved on Nov 11
    const rows = await prisma.stockDay.findMany({ orderBy: { day: 'asc' } });

    assert({
      given: 'three nights, the last one after a day without movements',
      should: 'store each day that changed and skip the one that did not',
      actual: rows.map((r) => [r.day.toISOString().slice(0, 10), r.quantity, r.restocked]),
      expected: [
        ['2026-11-09', 15, true],
        ['2026-11-10', 10, false],
      ],
    });
  });
});

describe('recordStockDays() rerun', () => {
  test('the same night twice', async () => {
    await movements();
    await recordStockDays(prisma, at('2026-11-10T09:00:00Z'));
    await recordStockDays(prisma, at('2026-11-10T10:00:00Z'));
    const rows = await prisma.stockDay.findMany();

    assert({
      given: 'the nightly job run twice on one night',
      should: 'store that day once',
      actual: rows.map((r) => [r.day.toISOString().slice(0, 10), r.quantity, r.restocked]),
      expected: [['2026-11-09', 15, true]],
    });
  });
});

describe('recordStockDays() after a gap', () => {
  test('nights missed since the last stored day', async () => {
    await movements();
    await prisma.stockDay.create({ data: { productId: product, locationId: centro, day: new Date('2026-11-08'), quantity: 10 } });
    await recordStockDays(prisma, at('2026-11-11T09:00:00Z')); // the first run, two days after the import's last day
    const rows = await prisma.stockDay.findMany({ orderBy: { day: 'asc' } });

    assert({
      given: 'days stored up to a date and the next run two nights later',
      should: 'fill every day in between, not just the last one',
      actual: rows.map((r) => [r.day.toISOString().slice(0, 10), r.quantity, r.restocked]),
      expected: [
        ['2026-11-08', 10, false],
        ['2026-11-09', 15, true],
        ['2026-11-10', 10, false],
      ],
    });
  });
});
