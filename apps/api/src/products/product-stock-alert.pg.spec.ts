/**
 * The stock alert on product rows, and the stock chips and counts built on it:
 * only regular sellers alert, a paused product counts only as paused (see
 * testing/pglite.ts; stats come from the nightly job, stock-stats.ts).
 */
import { assert } from 'riteway/vitest';
import type { PauseReason } from '@prisma/client';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';
import { businessDay, parseBusinessDate } from '../inventory/business-date';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

interface Stats { unitsSold: number; weeksWithSales: number; typicalOnHand: number; zeroSince?: string; stockAtEnd?: number; computedAt?: Date }

/**
 * A store of its own (default settings: 90-day window, 14 days of cover, regular
 * seller in ≥ 4 weeks) with one product per case. A rate of 1 a day means 90 units.
 */
async function store() {
  const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Alertas' } });
  const product = async (name: string, o: { qty: number; stats?: Stats; paused?: PauseReason }) => {
    const { id } = await prisma.product.create({ data: { name: `${name}-${Math.random()}`, soldOnlyAtLocationId: locationId } });
    if (o.qty > 0) await prisma.inventory.create({ data: { productId: id, locationId, quantity: o.qty, unitCost: 1, receivedAt: new Date('2026-10-01') } });
    if (o.stats) {
      const { zeroSince, ...s } = o.stats;
      await prisma.productStockStats.create({
        data: { productId: id, locationId, windowDays: 90, daysAtZero: 0, stockOuts: 0, computedAt: new Date(), ...s, zeroSince: zeroSince ? new Date(zeroSince) : null },
      });
    }
    if (o.paused) await prisma.productStoreStatus.create({ data: { productId: id, locationId, pausedAt: new Date(), pauseReason: o.paused } });
    return id;
  };
  const regular = { unitsSold: 90, weeksWithSales: 10, typicalOnHand: 20 };
  return {
    locationId,
    product,
    out: await product('Agotado', { qty: 0, stats: { ...regular, zeroSince: '2026-11-10T06:00:00.000Z' } }),
    outEarlier: await product('AgotadoAntes', { qty: 0, stats: { unitsSold: 45, weeksWithSales: 6, typicalOnHand: 5, zeroSince: '2026-11-01T06:00:00.000Z' } }),
    outUnknownSince: await product('AgotadoSinFecha', { qty: 0, stats: { unitsSold: 9, weeksWithSales: 4, typicalOnHand: 2 } }),
    neverSold: await product('SinVentas', { qty: 0 }),
    low: await product('Poco', { qty: 5, stats: regular }),
    usuallyAtOne: await product('SiempreUno', { qty: 1, stats: { unitsSold: 30, weeksWithSales: 8, typicalOnHand: 1 } }),
    slow: await product('Lento', { qty: 1, stats: { unitsSold: 3, weeksWithSales: 2, typicalOnHand: 2 } }),
    plenty: await product('Mucho', { qty: 50, stats: regular }),
    pausedAtZero: await product('PausadoAgotado', { qty: 0, stats: regular, paused: 'SUPPLIER_UNAVAILABLE' }),
    pausedInStock: await product('PausadoConExistencia', { qty: 30, stats: regular, paused: 'SLOW_MOVER' }),
  };
}

describe('stockAlert on product rows', () => {
  test('alert levels', async () => {
    const products = new ProductsService(prisma);
    const s = await store();
    const ids = [s.out, s.outUnknownSince, s.neverSold, s.low, s.usuallyAtOne, s.slow, s.plenty, s.pausedAtZero];
    const rows = (await products.getProducts(s.locationId, { onlyIds: ids, limit: 50 })).data;

    assert({
      given: 'regular sellers out and low, a product that normally sits at 1, a slow mover, one never sold, and a paused one at 0',
      should: 'alert only the regular sellers out or under their cover, out ranked by its rate and low by rate over stock, and the paused one only as paused',
      actual: rows.map((r) => r.stockAlert),
      expected: [
        { level: 'out', priority: 1, paused: false, pauseReason: null, zeroSince: '2026-11-10T06:00:00.000Z', rate: 1, lastSoldAt: null },
        { level: 'out', priority: 0.1, paused: false, pauseReason: null, zeroSince: null, rate: 0.1, lastSoldAt: null },
        { level: 'none', priority: 0, paused: false, pauseReason: null, zeroSince: null, rate: null, lastSoldAt: null },
        { level: 'low', priority: 0.2, paused: false, pauseReason: null, zeroSince: null, rate: 1, lastSoldAt: null },
        { level: 'none', priority: 0, paused: false, pauseReason: null, zeroSince: null, rate: 30 / 90, lastSoldAt: null },
        { level: 'none', priority: 0, paused: false, pauseReason: null, zeroSince: null, rate: 3 / 90, lastSoldAt: null },
        { level: 'none', priority: 0, paused: false, pauseReason: null, zeroSince: null, rate: 1, lastSoldAt: null },
        { level: 'none', priority: 0, paused: true, pauseReason: 'SUPPLIER_UNAVAILABLE', zeroSince: null, rate: 1, lastSoldAt: null },
      ],
    });
  });

  test('product detail', async () => {
    const products = new ProductsService(prisma);
    const s = await store();

    assert({
      given: 'a paused product\'s detail at its store, and the same product without a store',
      should: 'carry its alert at the store, and none without one',
      actual: [(await products.getProduct(s.pausedInStock, s.locationId)).data.stockAlert, (await products.getProduct(s.pausedInStock)).data.stockAlert],
      expected: [{ level: 'none', priority: 0, paused: true, pauseReason: 'SLOW_MOVER', zeroSince: null, rate: 1, lastSoldAt: null }, null],
    });
  });
});

describe('stock chips and counts', () => {
  test('filters and counts with paused products', async () => {
    const products = new ProductsService(prisma);
    const s = await store();
    const listed = async (filter: 'outOfStock' | 'lowStock' | 'inStock' | 'paused') =>
      (await products.getProducts(s.locationId, { filter, limit: 50 })).data.map((p) => p.id);
    const out = await listed('outOfStock');
    const c = (await products.getProductCounts(s.locationId)).data;

    assert({
      given: 'products out (two with a known start), low, in stock, and paused at 0 and in stock',
      should: 'list out of stock by stock alone without the paused, latest stock-out first and unknown last; low by alert; paused whatever its stock; in stock as the rest',
      actual: [out.slice(0, 2), [...out.slice(2)].sort(), await listed('lowStock'), (await listed('paused')).sort(), (await listed('inStock')).sort()],
      expected: [
        [s.out, s.outEarlier],
        [s.outUnknownSince, s.neverSold].sort(),
        [s.low],
        [s.pausedAtZero, s.pausedInStock].sort(),
        [s.usuallyAtOne, s.slow, s.plenty].sort(),
      ],
    });

    assert({
      given: 'the same store',
      should: 'count each chip as its list, so in stock is the total less out, low and paused',
      actual: [c.total, c.outOfStock, c.lowStock, c.paused, c.total - c.outOfStock - c.lowStock - c.paused],
      expected: [10, 4, 1, 2, 3],
    });
  });
});

describe('stockAlert in the phones\' sync', () => {
  test('a product paused after the last sync', async () => {
    const products = new ProductsService(prisma);
    const s = await store();
    let cursor: string | undefined;
    for (let more = true; more; ) ({ cursor, hasMore: more } = await products.syncProducts(s.locationId, cursor, 500));
    await prisma.productStoreStatus.create({ data: { productId: s.plenty, locationId: s.locationId, pausedAt: new Date(), pauseReason: 'OTHER' } });
    const next = await products.syncProducts(s.locationId, cursor, 500);

    assert({
      given: 'a phone caught up with the sync, then a product paused at its store',
      should: 'send that product in the next sync, paused',
      actual: next.data.map((p) => [p.id, p.stockAlert?.paused, p.stockAlert?.pauseReason]),
      expected: [[s.plenty, true, 'OTHER']],
    });
  });
});

describe('stockAlert.lastSoldAt in the phones\' sync', () => {
  test('a nightly run that moves only the last sale', async () => {
    const products = new ProductsService(prisma);
    const s = await store();
    let cursor: string | undefined;
    for (let more = true; more; ) ({ cursor, hasMore: more } = await products.syncProducts(s.locationId, cursor, 500));
    await prisma.productStockStats.update({
      where: { productId_locationId: { productId: s.plenty, locationId: s.locationId } },
      data: { lastSoldAt: new Date('2026-11-12T20:15:00.000Z'), computedAt: new Date() },
    });
    const next = await products.syncProducts(s.locationId, cursor, 500);

    assert({
      given: 'a phone caught up with the sync, then a nightly run that changes only a product\'s last sale (a sale in, another out of the window)',
      should: 'send that product in the next sync with its new last sale',
      actual: next.data.map((p) => [p.id, p.stockAlert?.lastSoldAt]),
      expected: [[s.plenty, '2026-11-12T20:15:00.000Z']],
    });
  });
});

describe('stockAlert.zeroSince during the day', () => {
  test('stock that changed since last night\'s stats', async () => {
    const products = new ProductsService(prisma);
    const s = await store();
    const regular = { unitsSold: 90, weeksWithSales: 10, typicalOnHand: 20 };
    const ranOutToday = await s.product('AgotadoHoy', { qty: 0, stats: { ...regular, stockAtEnd: 3 } });
    const restockedToday = await s.product('SurtidoHoy', { qty: 8, stats: { ...regular, zeroSince: '2026-11-05T06:00:00.000Z', stockAtEnd: 0 } });
    const rows = (await products.getProducts(s.locationId, { onlyIds: [ranOutToday, restockedToday], limit: 50 })).data;
    const out = (await products.getProducts(s.locationId, { filter: 'outOfStock', limit: 50 })).data.map((p) => p.id);
    const today = parseBusinessDate(businessDay(new Date()), 'start').toISOString();

    assert({
      given: 'one product in stock last night and at 0 now, and one at 0 last night and restocked since',
      should: 'date the first\'s run at 0 today and list it first among the out of stock, and give the restocked one no run at 0',
      actual: [rows.map((r) => r.stockAlert?.zeroSince), out[0]],
      expected: [[today, null], ranOutToday],
    });
  });
});

describe('stockAlert.zeroSince after a missed night', () => {
  test('stats older than today', async () => {
    const products = new ProductsService(prisma);
    const s = await store();
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const id = await s.product('AgotadoSinCorrida', { qty: 0, stats: { unitsSold: 90, weeksWithSales: 10, typicalOnHand: 20, stockAtEnd: 3, computedAt: twoDaysAgo } });
    const [row] = (await products.getProducts(s.locationId, { onlyIds: [id], limit: 50 })).data;

    assert({
      given: 'a product at 0 whose last stats, from before today, had it in stock',
      should: 'leave its run at 0 unknown, since it could have run out any day since',
      actual: row.stockAlert?.zeroSince,
      expected: null,
    });
  });
});

describe('the Alertas lists', () => {
  test('ranked by lost sales', async () => {
    const products = new ProductsService(prisma);
    const s = await store();
    const outLongAgoBestSeller = await s.product('AgotadoHaceMucho', { qty: 0, stats: { unitsSold: 180, weeksWithSales: 12, typicalOnHand: 30, zeroSince: '2026-10-01T06:00:00.000Z' } });
    const lowNewerSlower = await s.product('PocoReciente', { qty: 9, stats: { unitsSold: 90, weeksWithSales: 10, typicalOnHand: 20 } });
    const listed = async (filter: 'outAlert' | 'lowAlert') => (await products.getProducts(s.locationId, { filter, limit: 50 })).data.map((p) => p.id);
    const c = (await products.getProductCounts(s.locationId)).data;

    assert({
      given: 'regular sellers out and low, plus out-of-stock products that don\'t alert (never sold, paused)',
      should: 'list only the alerting ones, highest lost sales a day first whatever their stock-out date or age, and count the out list',
      actual: [await listed('outAlert'), await listed('lowAlert'), c.outAlert],
      expected: [[outLongAgoBestSeller, s.out, s.outEarlier, s.outUnknownSince], [s.low, lowNewerSlower], 4],
    });
  });
});

describe('paging a list with ties', () => {
  test('same priority and same age', async () => {
    const products = new ProductsService(prisma);
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Empates' } });
    const createdAt = new Date('2026-09-01T12:00:00.000Z');
    const run = Math.random().toString(36).slice(2);
    // Ids that sort opposite to the order they're created in, so the database's own order can't pass for id order
    const tied = async (name: string) => {
      const { id } = await prisma.product.create({ data: { id: `${name}-${run}`, name, createdAt, soldOnlyAtLocationId: locationId } });
      await prisma.productStockStats.create({ data: { productId: id, locationId, windowDays: 90, daysAtZero: 0, stockOuts: 0, unitsSold: 4, weeksWithSales: 4, typicalOnHand: 2, computedAt: new Date() } });
      return id;
    };
    const ids = [await tied('empate-c'), await tied('empate-b'), await tied('empate-a')];
    const pages = async (filter: 'outAlert' | 'outOfStock') =>
      Promise.all([1, 2, 3].map(async (page) => (await products.getProducts(locationId, { filter, page, limit: 1 })).data[0]?.id));

    assert({
      given: 'three out-of-stock regular sellers created together with the same sales, paged one at a time',
      should: 'show each once, in id order, on the Alertas list and on Productos\' out of stock',
      actual: [await pages('outAlert'), await pages('outOfStock')],
      expected: [[...ids].sort(), [...ids].sort()],
    });
  });
});

describe('stockAlert.rate and lastSoldAt', () => {
  test('the nightly stats\' sales rate on every row', async () => {
    const products = new ProductsService(prisma);
    const s = await store();
    const soldNothing = await s.product('SinVentasEnVentana', { qty: 3, stats: { unitsSold: 0, weeksWithSales: 0, typicalOnHand: 3 } });
    await prisma.productStockStats.update({ where: { productId_locationId: { productId: s.plenty, locationId: s.locationId } }, data: { lastSoldAt: new Date('2026-11-12T20:15:00.000Z') } });
    const ids = [s.out, s.plenty, s.pausedAtZero, soldNothing, s.neverSold];
    const rows = (await products.getProducts(s.locationId, { onlyIds: ids, limit: 50 })).data;
    const pick = (a: { rate: number | null; lastSoldAt: string | null } | null) => a && { rate: a.rate, lastSoldAt: a.lastSoldAt };

    assert({
      given: 'an out alert, one in stock with its last sale, a paused one, one with stats but no sale in the window, and one without stats',
      should: 'give each with stats its units a day over the window (0 with no sales) and its last sale, at any level, and none without stats',
      actual: rows.map((r) => pick(r.stockAlert)),
      expected: [
        { rate: 1, lastSoldAt: null },
        { rate: 1, lastSoldAt: '2026-11-12T20:15:00.000Z' },
        { rate: 1, lastSoldAt: null },
        { rate: 0, lastSoldAt: null },
        { rate: null, lastSoldAt: null },
      ],
    });
  });
});

describe('stockAlert.lastSoldAt with today\'s sales', () => {
  test('a sale since last night\'s stats', async () => {
    const products = new ProductsService(prisma);
    const s = await store();
    const { id: otherStore } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Otra' } });
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const soldAt = new Date(Date.now() - 1000);
    const sell = (productId: string, locationId: string) =>
      prisma.sale.create({
        data: { squareId: `pay-${Math.random()}`, locationId, totalRevenue: 10, totalCost: 5, grossProfit: 5, createdAt: soldAt, items: { create: [{ productId, quantity: 1, price: 10, cost: 5 }] } },
      });
    const lastNight = (productId: string) =>
      prisma.productStockStats.update({ where: { productId_locationId: { productId, locationId: s.locationId } }, data: { lastSoldAt: twoDaysAgo } });
    await lastNight(s.plenty);
    await lastNight(s.low);
    await sell(s.plenty, s.locationId);
    await sell(s.low, otherStore);
    await sell(s.neverSold, s.locationId);
    const rows = (await products.getProducts(s.locationId, { onlyIds: [s.plenty, s.low, s.neverSold], limit: 50 })).data;

    assert({
      given: 'a product sold here today, one sold today only at another store, and one without stats sold here today',
      should: 'give the first and the last today\'s sale as their last sale, and the second last night\'s',
      actual: rows.map((r) => r.stockAlert?.lastSoldAt),
      expected: [soldAt.toISOString(), twoDaysAgo.toISOString(), soldAt.toISOString()],
    });
  });
});
