/**
 * The one-time dead-item cleanup (Fredy, 2026-11-21): pause what has sat at 0
 * without a sale for over 2 years (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { deadItems, pauseDeadItems } from './dead-items';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

const NOW = new Date('2026-11-21T18:00:00Z');
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

/** A store and a way to add a product received there once, with `qty` left and its last sale. */
async function store() {
  const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Limpieza' } });
  const product = async (name: string, { qty = 0, lastSoldAt = null as Date | null, paused = false, at = locationId } = {}) => {
    const { id } = await prisma.product.create({ data: { name } });
    await prisma.inventory.create({ data: { productId: id, locationId: at, quantity: qty, unitCost: 1, receivedAt: daysBefore(1000) } });
    await prisma.productStockStats.create({
      data: {
        productId: id, locationId: at, windowDays: 90, unitsSold: 0, weeksWithSales: 0, typicalOnHand: 1,
        daysAtZero: qty > 0 ? 0 : 20, stockOuts: 1, computedAt: daysBefore(0.4), lastSoldAt, zeroSince: qty > 0 ? null : daysBefore(20),
      },
    });
    if (paused) await prisma.productStoreStatus.create({ data: { productId: id, locationId: at, pausedAt: daysBefore(5), pauseReason: 'OTHER' } });
    return id;
  };
  const names = async () => (await deadItems(prisma, locationId, { now: NOW })).map((s) => s.product.name).sort();
  return { locationId, product, names };
}

describe('deadItems', () => {
  test('the 2-year line', async () => {
    const s = await store();
    await s.product('Sold731DaysAgo', { lastSoldAt: daysBefore(731) });
    await s.product('Sold730DaysAgo', { lastSoldAt: daysBefore(730) });
    await s.product('Sold729DaysAgo', { lastSoldAt: daysBefore(729) });
    await s.product('NeverSold');
    assert({
      given: 'products at 0 with no sale in the window, last sold just over, exactly, and just under 2 years ago, and one never sold',
      should: 'pick the one over 2 years and the one never sold',
      actual: await s.names(),
      expected: ['NeverSold', 'Sold731DaysAgo'],
    });
  });

  test('products left out', async () => {
    const s = await store();
    const { id: elsewhere } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Otra' } });
    await s.product('InStock', { qty: 2, lastSoldAt: daysBefore(800) });
    await s.product('AlreadyPaused', { lastSoldAt: daysBefore(800), paused: true });
    await s.product('DeadElsewhere', { lastSoldAt: daysBefore(800), at: elsewhere });
    await s.product('Dead', { lastSoldAt: daysBefore(800) });
    assert({
      given: 'dead-looking products that are in stock, already paused, or dead at another store',
      should: 'pick only the one at 0 here and not paused',
      actual: await s.names(),
      expected: ['Dead'],
    });
  });
});

describe('deadItems with an equivalent selling', () => {
  test('suggested as equivalent selling', async () => {
    const s = await store();
    const dead = await s.product('DeadWithEquivalent', { lastSoldAt: daysBefore(800) });
    const equivalent = await s.product('Equivalent', { qty: 5, lastSoldAt: daysBefore(1) });
    const { id: groupId } = await prisma.equivalenceGroup.create({ data: {} });
    await prisma.product.updateMany({ where: { id: { in: [dead, equivalent] } }, data: { equivalenceGroupId: groupId } });
    const sale = await prisma.sale.create({ data: { squareId: `PAY-${Math.random()}`, locationId: s.locationId, totalRevenue: 9, totalCost: 0, grossProfit: 9, createdAt: daysBefore(3) } });
    await prisma.saleItem.create({ data: { saleId: sale.id, productId: equivalent, quantity: 9, price: 1, cost: 0 } });
    assert({
      given: 'a product at 0 not sold in over 2 years whose equivalent sells here',
      should: 'leave it to its equivalent-selling suggestion (only no-sales suggestions are cleaned up)',
      actual: await s.names(),
      expected: [],
    });
  });
});

describe('pauseDeadItems', () => {
  test('pausing them', async () => {
    const s = await store();
    const dead = await s.product('Dead', { lastSoldAt: daysBefore(800) });
    await s.product('Recent', { lastSoldAt: daysBefore(300) });
    const paused = (await pauseDeadItems(prisma, s.locationId, { now: NOW })).map((i) => i.product.name);
    const status = await prisma.productStoreStatus.findMany({ where: { locationId: s.locationId }, select: { productId: true, pauseReason: true, pauseNote: true } });
    assert({
      given: 'one dead product and one that sold within 2 years',
      should: "pause only the dead one, as a slow mover noted as the cleanup of the store's day, and say which it paused",
      actual: { paused, status },
      expected: { paused: ['Dead'], status: [{ productId: dead, pauseReason: 'SLOW_MOVER', pauseNote: 'Limpieza 2026-11-21' }] },
    });
  });

  test('more than one bulk pause holds, and a re-run', async () => {
    const s = await store();
    for (let i = 0; i < 201; i++) await s.product(`Dead${i}`);
    const first = (await pauseDeadItems(prisma, s.locationId, { now: NOW })).length;
    const pausedAt = await prisma.productStoreStatus.findMany({ where: { locationId: s.locationId }, select: { productId: true, pausedAt: true, pauseNote: true }, orderBy: { productId: 'asc' } });
    const second = (await pauseDeadItems(prisma, s.locationId, { now: NOW })).length;
    const after = await prisma.productStoreStatus.findMany({ where: { locationId: s.locationId }, select: { productId: true, pausedAt: true, pauseNote: true }, orderBy: { productId: 'asc' } });
    assert({
      given: '201 dead products (over the 200 a bulk pause takes), cleaned up twice',
      should: 'pause all 201 the first time, each with the note, and nothing the second, leaving the pauses as they were',
      actual: { first, pausedCount: pausedAt.length, notes: [...new Set(pausedAt.map((p) => p.pauseNote))], second, unchanged: JSON.stringify(after) === JSON.stringify(pausedAt) },
      expected: { first: 201, pausedCount: 201, notes: ['Limpieza 2026-11-21'], second: 0, unchanged: true },
    });
  }, 60_000);
});
