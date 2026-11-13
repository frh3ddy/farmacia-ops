/**
 * The nightly per product × store stats, from stored stock days and sales
 * (Square history and live sales) (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { recordStockStats } from './stock-stats';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let norte: string;
let product: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-C', name: 'Centro' } }));
  ({ id: norte } = await prisma.location.create({ data: { squareId: 'SQ-N', name: 'Norte' } })); // no settings row
  ({ id: product } = await prisma.product.create({ data: { name: 'Paracetamol' } }));
  await prisma.stockAlertSettings.create({ data: { locationId: centro, windowDays: 14 } });
}, 120_000);

afterAll(() => stop?.());

beforeEach(async () => {
  await prisma.productStockStats.deleteMany();
  await prisma.stockDay.deleteMany();
  await prisma.salesHistoryLine.deleteMany();
  await prisma.saleReturnItem.deleteMany();
  await prisma.saleReturn.deleteMany();
  await prisma.inventoryAdjustment.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
});

const at = (day: string) => new Date(`${day}T18:00:00Z`); // noon on the store clock

const stockDay = (day: string, quantity: number) =>
  prisma.stockDay.create({ data: { productId: product, locationId: centro, day: new Date(day), quantity, restocked: quantity > 0 } });

const historyLine = (day: string, quantity: number) =>
  prisma.salesHistoryLine.create({
    data: { squareOrderId: `o-${Math.random()}`, squareLineUid: 'l', locationId: centro, productId: product, quantity, soldAt: at(day) },
  });

const liveSale = (day: string, quantity: number, locationId = centro) =>
  prisma.sale.create({
    data: {
      squareId: `pay-${Math.random()}`, locationId, totalRevenue: 10, totalCost: 5, grossProfit: 5, createdAt: at(day),
      items: { create: { productId: product, quantity, price: 10, cost: 5 } },
    },
    include: { items: true },
  });

/** Units of a live sale given back, as a return records them. */
async function liveReturn(sale: Awaited<ReturnType<typeof liveSale>>, day: string, quantity: number) {
  const [item] = sale.items;
  const adjustment = await prisma.inventoryAdjustment.create({
    data: { locationId: sale.locationId, productId: product, type: 'RETURN', quantity, unitCost: 5, totalCost: 5 * quantity },
  });
  await prisma.saleReturn.create({
    data: {
      saleId: sale.id, clientRequestId: `ret-${Math.random()}`, returnedAt: at(day), revenue: 10, cost: 5,
      items: { create: { saleItemId: item.id, adjustmentId: adjustment.id, quantity, revenue: 10, cost: 5 } },
    },
  });
}

/** Nov 1–14 at a 14-day window: in stock at 3, out on Nov 3, restocked to 5 on Nov 6, out again on Nov 10. */
async function twoWeeks() {
  await stockDay('2026-10-20', 3);
  await stockDay('2026-11-03', 0);
  await stockDay('2026-11-06', 5);
  await stockDay('2026-11-10', 0);
  await historyLine('2026-10-01', 9); // before the window
  await historyLine('2026-11-02', 2);
  await historyLine('2026-11-03', 1);
  await liveSale('2026-11-09', 4);
}

const fields = (r: { windowDays: number; unitsSold: number; weeksWithSales: number; lastSoldAt: Date | null; typicalOnHand: number; daysAtZero: number; stockOuts: number; zeroSince: Date | null }) => ({
  windowDays: r.windowDays,
  unitsSold: r.unitsSold,
  weeksWithSales: r.weeksWithSales,
  lastSoldAt: r.lastSoldAt?.toISOString(),
  typicalOnHand: r.typicalOnHand,
  daysAtZero: r.daysAtZero,
  stockOuts: r.stockOuts,
  zeroSince: r.zeroSince?.toISOString(),
});

describe('recordStockStats()', () => {
  test('nightly', async () => {
    await twoWeeks();
    await recordStockStats(prisma, new Date('2026-11-15T09:00:00Z')); // 03:00 on Nov 15: the window ends Nov 14
    const rows = await prisma.productStockStats.findMany();

    assert({
      given: 'stored stock days, Square history and live sales, and the store\'s window',
      should: 'store the product\'s stats over the window ending yesterday, its last sale, and the start of its run at 0 at the store\'s midnight',
      actual: rows.map(fields),
      expected: [{
        windowDays: 14,
        unitsSold: 7,
        weeksWithSales: 2,
        lastSoldAt: '2026-11-09T18:00:00.000Z',
        typicalOnHand: 5,
        daysAtZero: 7,
        stockOuts: 2,
        zeroSince: '2026-11-10T06:00:00.000Z',
      }],
    });
  });

  test('the next night', async () => {
    await twoWeeks();
    await recordStockStats(prisma, new Date('2026-11-15T09:00:00Z'));
    await liveSale('2026-11-15', 1);
    await recordStockStats(prisma, new Date('2026-11-16T09:00:00Z'));
    const rows = await prisma.productStockStats.findMany();

    assert({
      given: 'a sale on the next day and a second night',
      should: 'update the product\'s one row, the window moved by a day, and count it at 0 from the day after its last unit sold',
      actual: rows.map((r) => [r.unitsSold, r.daysAtZero, r.lastSoldAt?.toISOString(), r.zeroSince?.toISOString()]),
      expected: [[8, 7, '2026-11-15T18:00:00.000Z', '2026-11-16T06:00:00.000Z']],
    });
  });

  test('sales that leave the window', async () => {
    await historyLine('2026-11-02', 1); // no stock days: only ever sold
    await recordStockStats(prisma, new Date('2026-11-15T09:00:00Z'));
    await recordStockStats(prisma, new Date('2026-12-01T09:00:00Z')); // the window is Nov 17–30
    const rows = await prisma.productStockStats.findMany();

    assert({
      given: 'a product with sales and no stock days, a night after its last sale left the window',
      should: 'update its row to no sales in the window, keeping its last sale',
      actual: rows.map((r) => [r.unitsSold, r.weeksWithSales, r.lastSoldAt?.toISOString()]),
      expected: [[0, 0, '2026-11-02T18:00:00.000Z']],
    });
  });

  test('a store without settings', async () => {
    await stockDay('2026-11-01', 0);
    const sale = await liveSale('2026-09-01', 3, norte); // 74 days before yesterday: outside a 14-day window, inside 90
    await liveReturn(sale, '2026-09-02', 1);
    await recordStockStats(prisma, new Date('2026-11-15T09:00:00Z'));
    const rows = await prisma.productStockStats.findMany({ include: { location: { select: { name: true } } }, orderBy: { location: { name: 'asc' } } });

    assert({
      given: 'a store with no settings row, a live sale and a return there, and stock days at another store',
      should: 'use the 90-day default and net the return, each store on its own',
      actual: rows.map((r) => [r.location.name, r.windowDays, r.unitsSold]),
      expected: [['Centro', 14, 0], ['Norte', 90, 2]],
    });
  });

  test('re-sent to the phones only on a change', async () => {
    await twoWeeks();
    const stamp = async () => (await prisma.$queryRaw<Array<{ x: string }>>`SELECT "changeXid"::text AS x FROM "Product" WHERE id = ${product}`)[0].x;
    await recordStockStats(prisma, new Date('2026-11-15T09:00:00Z'));
    const first = await stamp();
    await recordStockStats(prisma, new Date('2026-11-15T10:00:00Z')); // the same night again: nothing changed
    const unchanged = await stamp();
    await liveSale('2026-11-14', 1);
    await recordStockStats(prisma, new Date('2026-11-15T11:00:00Z'));

    assert({
      given: 'a second run with the same stats, then one after a new sale',
      should: 'leave the product\'s change stamp alone the first time and move it the second',
      actual: [unchanged === first, (await stamp()) === first],
      expected: [true, false],
    });
  });
});
