/**
 * Pause suggestions (stock alerts O7): products a store could pause, from the
 * nightly stats, for a person to review (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import type { PauseSuggestionKind } from '@prisma/client';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { dismissPauseSuggestions, pauseSuggestions } from './pause-suggestions';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

const NOW = new Date('2026-11-21T18:00:00Z');
/** The nightly stats run (03:00 Mexico City). */
const LAST_NIGHT = new Date('2026-11-21T09:00:00Z');
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

interface Stats { unitsSold?: number; lastSoldAt?: Date | null; daysAtZero?: number; stockOuts?: number; zeroSince?: Date | null }
interface ProductCase {
  qty: number;
  stats?: Stats;
  groupId?: string;
  paused?: boolean;
  product?: { tracksInventory?: boolean; isDiscontinued?: boolean; soldOnlyAtLocationId?: string; medicationDefinitionId?: string };
}

/** A store of its own (default thresholds unless given) and a way to add products to it. */
async function store(settings?: { slowMaxUnits?: number; equivalentMinUnits?: number; windowDays?: number }) {
  const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Sugerencias' } });
  if (settings) await prisma.stockAlertSettings.create({ data: { locationId, ...settings } });
  const product = async (name: string, o: ProductCase) => {
    const { id } = await prisma.product.create({ data: { name, equivalenceGroupId: o.groupId, ...o.product } });
    if (o.qty > 0) await prisma.inventory.create({ data: { productId: id, locationId, quantity: o.qty, unitCost: 1, receivedAt: daysBefore(200) } });
    if (o.stats) {
      await prisma.productStockStats.create({
        data: {
          productId: id, locationId, windowDays: settings?.windowDays ?? 90, unitsSold: 0, weeksWithSales: 0, typicalOnHand: 1,
          daysAtZero: 0, stockOuts: 0, computedAt: LAST_NIGHT, lastSoldAt: null, zeroSince: null, ...o.stats,
        },
      });
    }
    if (o.paused) await prisma.productStoreStatus.create({ data: { productId: id, locationId, pausedAt: daysBefore(1), pauseReason: 'OTHER' } });
    return id;
  };
  const sell = async (productId: string, quantity: number, at: Date) => {
    const sale = await prisma.sale.create({
      data: { squareId: `PAY-${Math.random()}`, locationId, totalRevenue: quantity, totalCost: 0, grossProfit: quantity, createdAt: at },
    });
    await prisma.saleItem.create({ data: { saleId: sale.id, productId, quantity, price: 1, cost: 0 } });
  };
  const list = async (o: { page?: number; limit?: number; now?: Date } = {}) => pauseSuggestions(prisma, locationId, { now: NOW, ...o });
  const kinds = async (now = NOW) => (await list({ now })).data.map((s) => [s.product.name, s.kind]);
  return { locationId, product, sell, list, kinds };
}

const group = async () => (await prisma.equivalenceGroup.create({ data: {} })).id;
/** At 0 with no sale in the window, but under 30 days at 0 and out once, so not also SLOW_WITH_STOCKOUTS. */
const atZeroNoSales: ProductCase = { qty: 0, stats: { lastSoldAt: daysBefore(120), daysAtZero: 20, stockOuts: 1, zeroSince: daysBefore(20) } };

describe('pauseSuggestions NO_SALES_AT_ZERO', () => {
  test('at 0 with no sale in the window', async () => {
    const s = await store();
    const id = await s.product('Ambroxol', atZeroNoSales);
    await s.product('VendidoHace10', { qty: 0, stats: { unitsSold: 3, lastSoldAt: daysBefore(10), daysAtZero: 5, zeroSince: daysBefore(5) } });
    await s.product('ConExistencia', { qty: 4, stats: { lastSoldAt: daysBefore(120), daysAtZero: 0 } });

    assert({
      given: 'a product at 0 last sold before the window, one sold in the window, and one in stock',
      should: 'suggest only the first, with its last sale, 0 units, days at 0 and stock-outs',
      actual: (await s.list()).data,
      expected: [{
        product: { id, name: 'Ambroxol' }, kind: 'NO_SALES_AT_ZERO', lastSoldAt: daysBefore(120).toISOString(),
        unitsInWindow: 0, daysAtZero: 20, stockOuts: 1, equivalent: null,
      }],
    });
  });
});

describe('pauseSuggestions NO_SALES_AT_ZERO sold today', () => {
  test('a sale after last night\'s stats', async () => {
    const s = await store();
    const id = await s.product('SoldToday', atZeroNoSales);
    await s.sell(id, 1, daysBefore(0.1)); // sold below 0, as Square allows
    assert({ given: 'a product at 0 that sold today, after the nightly stats', should: 'not suggest it as having no sales', actual: await s.kinds(), expected: [] });
  });
});

describe('pauseSuggestions SLOW_WITH_STOCKOUTS', () => {
  test('slow sellers that run out', async () => {
    const s = await store();
    await s.product('LongAtZero', { qty: 1, stats: { unitsSold: 2, lastSoldAt: daysBefore(5), daysAtZero: 30, stockOuts: 1 } });
    await s.product('TwoStockOuts', { qty: 1, stats: { unitsSold: 1, lastSoldAt: daysBefore(5), daysAtZero: 3, stockOuts: 2 } });
    await s.product('SellsMore', { qty: 1, stats: { unitsSold: 3, lastSoldAt: daysBefore(5), daysAtZero: 40, stockOuts: 3 } });
    await s.product('RarelyOut', { qty: 1, stats: { unitsSold: 2, lastSoldAt: daysBefore(5), daysAtZero: 29, stockOuts: 1 } });

    assert({
      given: 'slow sellers long at 0 or out twice, one selling more, and one rarely out',
      should: 'suggest only the slow ones that run out',
      actual: await s.kinds(),
      expected: [['LongAtZero', 'SLOW_WITH_STOCKOUTS'], ['TwoStockOuts', 'SLOW_WITH_STOCKOUTS']],
    });
  });

  test("the store's thresholds", async () => {
    const s = await store({ slowMaxUnits: 5 });
    await s.product('Five', { qty: 1, stats: { unitsSold: 5, lastSoldAt: daysBefore(5), daysAtZero: 40 } });
    assert({ given: 'a store whose slow sellers sell up to 5', should: 'suggest one that sold 5', actual: await s.kinds(), expected: [['Five', 'SLOW_WITH_STOCKOUTS']] });
  });

  /** 0 sales and the whole window at 0: fits both kinds' rules. */
  const neverSoldLongAtZero: ProductCase = { qty: 0, stats: { unitsSold: 0, lastSoldAt: null, daysAtZero: 90, stockOuts: 0, zeroSince: daysBefore(90) } };

  test('a product with no sales, long at 0', async () => {
    const s = await store();
    await s.product('Both', neverSoldLongAtZero);
    assert({
      given: 'a product with no sales and at 0 for 30 days or more',
      should: 'suggest it once, as having no sales',
      actual: await s.kinds(),
      expected: [['Both', 'NO_SALES_AT_ZERO']],
    });
  });

  test('its no-sales suggestion dismissed', async () => {
    const s = await store();
    const productId = await s.product('Both', neverSoldLongAtZero);
    await dismissPauseSuggestions(prisma, { locationId: s.locationId, items: [{ productId, kind: 'NO_SALES_AT_ZERO' }], now: daysBefore(1) });
    assert({
      given: 'that suggestion dismissed',
      should: 'not suggest it as a slow seller instead',
      actual: await s.kinds(),
      expected: [],
    });
  });

  test('one sale and out twice', async () => {
    const s = await store();
    await s.product('OneSale', { qty: 0, stats: { unitsSold: 1, lastSoldAt: daysBefore(40), daysAtZero: 10, stockOuts: 2, zeroSince: daysBefore(10) } });
    assert({
      given: 'a product at 0 with one sale in the window and two stock-outs',
      should: 'suggest it only as a slow seller',
      actual: await s.kinds(),
      expected: [['OneSale', 'SLOW_WITH_STOCKOUTS']],
    });
  });
});

describe('pauseSuggestions EQUIVALENT_SELLING', () => {
  /** A product at 0 since 20 days ago (sold 10 a while back, so no other kind) and an equivalent. */
  async function pair(o: { equivalent?: Partial<ProductCase>; sold?: number; sameGroup?: boolean } = {}) {
    const s = await store();
    const groupId = await group();
    const atZero = await s.product('Paracetamol MK', { qty: 0, groupId, stats: { unitsSold: 10, lastSoldAt: daysBefore(21), daysAtZero: 20, stockOuts: 1, zeroSince: daysBefore(20) } });
    const equivalent = await s.product('Paracetamol Genfar', { qty: 5, groupId: o.sameGroup === false ? undefined : groupId, ...o.equivalent });
    await s.sell(equivalent, 30, daysBefore(25)); // before the run at 0: doesn't count
    await s.sell(equivalent, o.sold ?? 14, daysBefore(3));
    return { s, atZero, equivalent };
  }

  test('an equivalent selling while it is at 0', async () => {
    const { s, atZero, equivalent } = await pair();
    assert({
      given: 'a product at 0 whose equivalent is in stock here and sold since it ran out',
      should: 'suggest it, naming the equivalent and what it sold since',
      actual: (await s.list()).data,
      expected: [{
        product: { id: atZero, name: 'Paracetamol MK' }, kind: 'EQUIVALENT_SELLING', lastSoldAt: daysBefore(21).toISOString(),
        unitsInWindow: 10, daysAtZero: 20, stockOuts: 1, equivalent: { id: equivalent, name: 'Paracetamol Genfar', unitsSince: 14 },
      }],
    });
  });

  test("equivalents that don't count", async () => {
    const cases = {
      'sold under the threshold': await pair({ sold: 2 }),
      paused: await pair({ equivalent: { paused: true } }),
      'out of stock': await pair({ equivalent: { qty: 0 } }),
      'only the same active ingredient': await pair({ sameGroup: false }),
    };
    const actual: Record<string, number> = {};
    for (const [name, { s }] of Object.entries(cases)) actual[name] = (await s.list()).data.length;
    assert({
      given: 'an equivalent that sold too little, is paused, is out of stock, or is not linked by hand',
      should: 'suggest nothing',
      actual,
      expected: { 'sold under the threshold': 0, paused: 0, 'out of stock': 0, 'only the same active ingredient': 0 },
    });
  });
});

describe('pauseSuggestions one row per product', () => {
  /** A product at 0 since 20 days ago, with `stats`, whose group-mate is in stock and sold 9 since. */
  async function losingSalesToEquivalent(stats: Stats) {
    const s = await store();
    const groupId = await group();
    const productId = await s.product('AtZero', { qty: 0, groupId, stats: { zeroSince: daysBefore(20), ...stats } });
    await s.sell(await s.product('Equivalent', { qty: 5, groupId }), 9, daysBefore(3));
    return { s, productId };
  }
  const noSalesInWindow: Stats = { lastSoldAt: daysBefore(120), daysAtZero: 20, stockOuts: 1 };
  const slowLongAtZero: Stats = { unitsSold: 1, lastSoldAt: daysBefore(30), daysAtZero: 40, stockOuts: 1 };

  test('no sales and an equivalent selling', async () => {
    const { s } = await losingSalesToEquivalent(noSalesInWindow);
    assert({ given: 'a product that fits no sales and equivalent selling', should: 'suggest it once, as equivalent selling', actual: await s.kinds(), expected: [['AtZero', 'EQUIVALENT_SELLING']] });
  });

  test('slow and an equivalent selling', async () => {
    const { s } = await losingSalesToEquivalent(slowLongAtZero);
    assert({ given: 'a product that fits slow seller and equivalent selling', should: 'suggest it once, as equivalent selling', actual: await s.kinds(), expected: [['AtZero', 'EQUIVALENT_SELLING']] });
  });

  test('its equivalent-selling suggestion dismissed', async () => {
    const cases = [await losingSalesToEquivalent(noSalesInWindow), await losingSalesToEquivalent(slowLongAtZero)];
    for (const { s, productId } of cases) {
      await dismissPauseSuggestions(prisma, { locationId: s.locationId, items: [{ productId, kind: 'EQUIVALENT_SELLING' }], now: daysBefore(1) });
    }
    assert({
      given: 'that suggestion dismissed, for one that also has no sales and one that is also slow',
      should: 'not suggest either under another kind',
      actual: [await cases[0].s.kinds(), await cases[1].s.kinds()],
      expected: [[], []],
    });
  });
});

describe('pauseSuggestions exclusions', () => {
  test('products that are never suggested', async () => {
    const s = await store();
    const { id: elsewhere } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Otra' } });
    await s.product('Paused', { ...atZeroNoSales, paused: true });
    await s.product('Yastas', { ...atZeroNoSales, product: { tracksInventory: false } });
    await s.product('Discontinued', { ...atZeroNoSales, product: { isDiscontinued: true } });
    await s.product('OtherStoreOnly', { ...atZeroNoSales, product: { soldOnlyAtLocationId: elsewhere } });
    await s.product('NoStats', { qty: 0 });
    assert({
      given: 'products paused, not tracked, discontinued, sold only at another store, or without stats',
      should: 'suggest none of them',
      actual: await s.kinds(),
      expected: [],
    });
  });
});

describe('pauseSuggestions order and pages', () => {
  test('order', async () => {
    const s = await store();
    const groupId = await group();
    await s.product('Slow', { qty: 1, stats: { unitsSold: 1, lastSoldAt: daysBefore(5), daysAtZero: 60 } });
    await s.product('NoSales15', { ...atZeroNoSales, stats: { ...atZeroNoSales.stats, daysAtZero: 15 } });
    await s.product('NoSales25', { ...atZeroNoSales, stats: { ...atZeroNoSales.stats, daysAtZero: 25 } });
    await s.product('Equivalent', { qty: 0, groupId, stats: { unitsSold: 10, lastSoldAt: daysBefore(11), daysAtZero: 10, zeroSince: daysBefore(10) } });
    await s.sell(await s.product('Other', { qty: 5, groupId }), 5, daysBefore(2));
    assert({
      given: 'suggestions of every kind',
      should: 'list equivalents selling first, then no sales, then slow, most days at 0 first',
      actual: await s.kinds(),
      expected: [['Equivalent', 'EQUIVALENT_SELLING'], ['NoSales25', 'NO_SALES_AT_ZERO'], ['NoSales15', 'NO_SALES_AT_ZERO'], ['Slow', 'SLOW_WITH_STOCKOUTS']],
    });
  });

  test('ties and pages', async () => {
    const s = await store();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await s.product(`Tie${i}`, atZeroNoSales));
    const first = await s.list({ limit: 2 });
    const second = await s.list({ limit: 2, page: 2 });
    assert({
      given: 'three suggestions with the same days at 0, two to a page',
      should: 'order them by product id across pages and say how many there are',
      actual: [[...first.data, ...second.data].map((r) => r.product.id), first.totalCount, second.data.length],
      expected: [[...ids].sort(), 3, 1],
    });
  });
});

describe('dismissPauseSuggestions', () => {
  async function dismissed(o: { kind?: PauseSuggestionKind; productCase?: ProductCase; dismissedDaysAgo?: number } = {}) {
    const s = await store();
    const kind = o.kind ?? 'NO_SALES_AT_ZERO';
    const productId = await s.product('Dismissed', o.productCase ?? atZeroNoSales);
    const { id: employeeId } = await prisma.employee.create({ data: { name: 'Gerente' } });
    await dismissPauseSuggestions(prisma, { locationId: s.locationId, items: [{ productId, kind }], employeeId, now: daysBefore(o.dismissedDaysAgo ?? 1) });
    const listed = async () => (await s.list()).data.filter((r) => r.kind === kind).length;
    return { s, productId, employeeId, listed };
  }

  test('a dismissed suggestion', async () => {
    const { listed } = await dismissed();
    assert({ given: 'a suggestion dismissed yesterday', should: 'hide it', actual: await listed(), expected: 0 });
  });

  test('after the window', async () => {
    const recent = await dismissed({ dismissedDaysAgo: 89 });
    const old = await dismissed({ dismissedDaysAgo: 91 });
    assert({
      given: 'suggestions dismissed 89 and 91 days ago, with a 90-day window and no new evidence',
      should: 'hide the first and show the second again',
      actual: [await recent.listed(), await old.listed()],
      expected: [0, 1],
    });
  });

  test('a sale since', async () => {
    const slowCase: ProductCase = { qty: 1, stats: { unitsSold: 1, lastSoldAt: daysBefore(30), daysAtZero: 40 } };
    const slow = await dismissed({ kind: 'SLOW_WITH_STOCKOUTS', productCase: slowCase });
    await slow.s.sell(slow.productId, 1, daysBefore(0.5));
    const before = await dismissed({ kind: 'SLOW_WITH_STOCKOUTS', productCase: slowCase, dismissedDaysAgo: 2 });
    await before.s.sell(before.productId, 1, daysBefore(3));
    assert({
      given: 'a slow seller sold after its dismissal, and one sold only before it',
      should: 'show the first again and keep hiding the second',
      actual: [await slow.listed(), await before.listed()],
      expected: [1, 0],
    });
  });

  test('a sale of a product whose equivalent is selling', async () => {
    const s = await store();
    const groupId = await group();
    const productId = await s.product('AtZero', { qty: 0, groupId, stats: { unitsSold: 10, lastSoldAt: daysBefore(21), daysAtZero: 20, zeroSince: daysBefore(20) } });
    await s.sell(await s.product('Equivalent', { qty: 5, groupId }), 9, daysBefore(3));
    await dismissPauseSuggestions(prisma, { locationId: s.locationId, items: [{ productId, kind: 'EQUIVALENT_SELLING' }], now: daysBefore(2) });
    await s.sell(productId, 1, daysBefore(1)); // sold below 0, as Square allows
    assert({ given: 'an EQUIVALENT_SELLING dismissal and a sale of the product since', should: 'keep it hidden', actual: (await s.list()).data.length, expected: 0 });
  });

  test('a receiving since', async () => {
    const slowCase: ProductCase = { qty: 0, stats: { unitsSold: 1, lastSoldAt: daysBefore(30), daysAtZero: 40 } };
    const { s, productId, listed } = await dismissed({ kind: 'SLOW_WITH_STOCKOUTS', productCase: slowCase });
    const batch = await prisma.inventory.create({ data: { productId, locationId: s.locationId, quantity: 3, unitCost: 1, receivedAt: daysBefore(400) } });
    await prisma.inventoryReceiving.create({ data: { locationId: s.locationId, productId, inventoryBatchId: batch.id, quantity: 3, unitCost: 1, totalCost: 3, receivedAt: daysBefore(400) } });
    assert({ given: 'a receiving recorded after the dismissal (dated earlier)', should: 'show it again', actual: await listed(), expected: 1 });
  });

  test('a received transfer since', async () => {
    const slowCase: ProductCase = { qty: 0, stats: { unitsSold: 1, lastSoldAt: daysBefore(30), daysAtZero: 40 } };
    const { s, productId, listed } = await dismissed({ kind: 'SLOW_WITH_STOCKOUTS', productCase: slowCase });
    const { id: from } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Origen' } });
    const source = await prisma.inventory.create({ data: { productId, locationId: from, quantity: 0, unitCost: 1, receivedAt: daysBefore(400) } });
    const transfer = await prisma.transfer.create({ data: { productId, fromLocationId: from, toLocationId: s.locationId, quantity: 2 } });
    const line = await prisma.transferLine.create({ data: { transferId: transfer.id, sourceInventoryId: source.id, quantity: 2, unitCost: 1, originalReceivedAt: daysBefore(400) } });
    const hiddenWhileShipped = await listed();
    const arrived = await prisma.inventory.create({ data: { productId, locationId: s.locationId, quantity: 2, unitCost: 1, receivedAt: daysBefore(400) } });
    await prisma.transferLine.update({ where: { id: line.id }, data: { destinationInventoryId: arrived.id, quantityReceived: 2 } });
    assert({
      given: 'a transfer shipped, then received after the dismissal',
      should: 'keep it hidden while shipped and show it again once received',
      actual: [hiddenWhileShipped, await listed()],
      expected: [0, 1],
    });
  });

  test('dismissing again', async () => {
    const { s, productId } = await dismissed({ dismissedDaysAgo: 80 });
    const { id: other } = await prisma.employee.create({ data: { name: 'Dueño' } });
    await dismissPauseSuggestions(prisma, { locationId: s.locationId, items: [{ productId, kind: 'NO_SALES_AT_ZERO' }, { productId, kind: 'NO_SALES_AT_ZERO' }], employeeId: other, now: daysBefore(1) });
    const rows = await prisma.pauseSuggestionDismissal.findMany({ where: { productId } });
    assert({
      given: 'a suggestion dismissed again, sent twice in one request',
      should: 'keep one dismissal that restarts the window and records who dismissed it last',
      actual: rows.map((r) => [r.dismissedAt.toISOString(), r.dismissedByEmployeeId]),
      expected: [[daysBefore(1).toISOString(), other]],
    });
  });

  test('a product the store does not have', async () => {
    const s = await store();
    const error = await dismissPauseSuggestions(prisma, { locationId: s.locationId, items: [{ productId: 'nope', kind: 'NO_SALES_AT_ZERO' }] }).catch((e) => e);
    assert({ given: 'an unknown product', should: 'refuse with 400', actual: error.status, expected: 400 });
  });
});
