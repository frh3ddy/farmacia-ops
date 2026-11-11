/**
 * Square sales history against a real Postgres engine (see testing/pglite.ts):
 * the one-time import of closed orders, and the sales velocity and busy hours
 * read from it together with the sales the app records live.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { busyHours, importSalesHistory, salesVelocity } from './sales-history';
import { ProductsController } from '../products/products.controller';
import { InventoryReportsController } from '../inventory/inventory-reports.controller';
import { InventoryReportsService } from '../inventory/inventory-reports.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let norte: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  ({ id: norte } = await prisma.location.create({ data: { squareId: 'SQ-NORTE', name: 'Norte' } }));
}, 120_000);

afterAll(() => stop?.());

beforeEach(async () => {
  await prisma.salesHistoryLine.deleteMany();
  await prisma.yastasOperation.deleteMany();
  await prisma.saleReturnItem.deleteMany();
  await prisma.saleReturn.deleteMany();
  await prisma.inventoryAdjustment.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
});

const DAY = 86_400_000;
const now = new Date('2026-11-10T18:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);

/** A closed Square order, shaped as SearchOrders returns it. */
const squareOrder = (o: {
  id: string;
  location?: string;
  closedAt: string;
  paymentId?: string;
  lines?: Array<{ uid: string; catalogObjectId?: string; quantity: string }>;
  returns?: Array<{ uid: string; catalogObjectId?: string; quantity: string }>;
  refundId?: string;
}) => ({
  id: o.id,
  locationId: o.location ?? 'SQ-CENTRO',
  state: 'COMPLETED',
  closedAt: o.closedAt,
  lineItems: o.lines ?? [],
  returns: o.returns ? [{ uid: `r-${o.id}`, returnLineItems: o.returns }] : undefined,
  tenders: o.paymentId ? [{ id: o.paymentId, paymentId: o.paymentId, type: 'CASH' }] : [],
  refunds: o.refundId ? [{ id: o.refundId, locationId: o.location ?? 'SQ-CENTRO', status: 'COMPLETED' }] : undefined,
});

/** A Square client whose SearchOrders answers with the given pages in turn. */
const squareWith = (...pages: Array<ReturnType<typeof squareOrder>[]>) => {
  const search = vi.fn();
  pages.forEach((orders, i) =>
    search.mockResolvedValueOnce({ orders, cursor: i < pages.length - 1 ? `page-${i + 1}` : undefined }),
  );
  return { client: { orders: { search } } as any, search };
};

const product = async () => {
  const { id } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
  await prisma.catalogMapping.create({ data: { productId: id, squareVariationId: `v-${id}` } });
  return id;
};

const lines = () =>
  prisma.salesHistoryLine.findMany({
    orderBy: [{ soldAt: 'asc' }, { squareLineUid: 'asc' }],
    select: { squareOrderId: true, squareLineUid: true, squarePaymentId: true, locationId: true, productId: true, squareVariationId: true, quantity: true, soldAt: true },
  });

/** A sale the app recorded live, with one item. */
const liveSale = async (o: { productId: string; locationId: string; at: Date; quantity: number; paymentId?: string }) => {
  const sale = await prisma.sale.create({
    data: {
      squareId: o.paymentId ?? `pay-${Math.random()}`,
      locationId: o.locationId,
      totalRevenue: 10, totalCost: 5, grossProfit: 5,
      createdAt: o.at,
      items: { create: { productId: o.productId, quantity: o.quantity, price: 10, cost: 5 } },
    },
    include: { items: true },
  });
  return sale;
};

/** Units of a live sale given back, as a return records them. */
const liveReturn = async (sale: Awaited<ReturnType<typeof liveSale>>, quantity: number, at: Date, clientRequestId = `ret-${Math.random()}`) => {
  const [item] = sale.items;
  const adjustment = await prisma.inventoryAdjustment.create({
    data: { locationId: sale.locationId, productId: item.productId, type: 'RETURN', quantity, unitCost: 5, totalCost: 5 * quantity },
  });
  await prisma.saleReturn.create({
    data: {
      saleId: sale.id, clientRequestId, returnedAt: at, revenue: 10, cost: 5,
      items: { create: { saleItemId: item.id, adjustmentId: adjustment.id, quantity, revenue: 10, cost: 5 } },
    },
  });
};

const historyLine = (o: { productId?: string | null; locationId: string; at: Date; quantity: number; order?: string; line?: string; paymentId?: string }) =>
  prisma.salesHistoryLine.create({
    data: {
      squareOrderId: o.order ?? `o-${Math.random()}`,
      squareLineUid: o.line ?? `l-${Math.random()}`,
      squarePaymentId: o.paymentId ?? null,
      locationId: o.locationId,
      productId: o.productId ?? null,
      quantity: o.quantity,
      soldAt: o.at,
    },
  });

describe('importSalesHistory (Postgres, Square recorded)', () => {
  test('closed orders from Square', async () => {
    const jarabe = await product();
    const { client, search } = squareWith(
      [
        squareOrder({
          id: 'o-1', closedAt: '2026-01-05T15:00:00Z', paymentId: 'pay-1',
          lines: [
            { uid: 'a', catalogObjectId: `v-${jarabe}`, quantity: '2' },
            { uid: 'b', catalogObjectId: 'v-not-mapped', quantity: '1' },
            { uid: 'c', quantity: '1' },
          ],
        }),
        squareOrder({ id: 'o-elsewhere', location: 'SQ-NOT-HERE', closedAt: '2026-01-05T16:00:00Z', lines: [{ uid: 'a', quantity: '1' }] }),
      ],
      [
        squareOrder({
          id: 'o-2', location: 'SQ-NORTE', closedAt: '2026-01-06T15:00:00Z',
          returns: [{ uid: 'r', catalogObjectId: `v-${jarabe}`, quantity: '1' }],
        }),
      ],
    );

    const result = await importSalesHistory(prisma, client, { save: true });
    const [first, second] = search.mock.calls.map(([request]) => request);

    assert({
      given: 'two pages of closed orders, with mapped, unmapped and custom lines, a return, and a store the app does not have',
      should: 'save one line per item at its store, keep the lines it cannot name a product for, save the return as a negative line, and skip the unknown store',
      actual: await lines(),
      expected: [
        { squareOrderId: 'o-1', squareLineUid: 'a', squarePaymentId: 'pay-1', locationId: centro, productId: jarabe, squareVariationId: `v-${jarabe}`, quantity: 2, soldAt: new Date('2026-01-05T15:00:00Z') },
        { squareOrderId: 'o-1', squareLineUid: 'b', squarePaymentId: 'pay-1', locationId: centro, productId: null, squareVariationId: 'v-not-mapped', quantity: 1, soldAt: new Date('2026-01-05T15:00:00Z') },
        { squareOrderId: 'o-1', squareLineUid: 'c', squarePaymentId: 'pay-1', locationId: centro, productId: null, squareVariationId: null, quantity: 1, soldAt: new Date('2026-01-05T15:00:00Z') },
        { squareOrderId: 'o-2', squareLineUid: 'r', squarePaymentId: null, locationId: norte, productId: jarabe, squareVariationId: `v-${jarabe}`, quantity: -1, soldAt: new Date('2026-01-06T15:00:00Z') },
      ],
    });

    assert({
      given: 'the same import',
      should: "ask Square for the stores' completed orders oldest closed first, follow the cursor, and count what it saved",
      actual: [
        first.locationIds.sort(),
        first.query,
        [first.cursor, second.cursor],
        result,
      ],
      expected: [
        ['SQ-CENTRO', 'SQ-NORTE'],
        {
          filter: { stateFilter: { states: ['COMPLETED'] }, dateTimeFilter: { closedAt: { startAt: '2020-01-01T00:00:00.000Z' } } },
          sort: { sortField: 'CLOSED_AT', sortOrder: 'ASC' },
        },
        [undefined, 'page-1'],
        { pages: 2, orders: 2, lines: 4, saved: 4, unmapped: 2 },
      ],
    });
  });

  test('a rerun after a stop', async () => {
    const orders = [
      squareOrder({ id: 'o-1', closedAt: '2026-01-05T15:00:00Z', lines: [{ uid: 'a', quantity: '1' }] }),
      squareOrder({ id: 'o-2', closedAt: '2026-01-06T15:00:00Z', lines: [{ uid: 'a', quantity: '1' }] }),
    ];
    await importSalesHistory(prisma, squareWith(orders).client, { save: true });

    const rerun = squareWith([orders[1]]);
    const result = await importSalesHistory(prisma, rerun.client, { save: true });

    assert({
      given: 'an import run again over orders it already saved',
      should: 'start from the last order saved and save nothing twice',
      actual: [rerun.search.mock.calls[0][0].query.filter.dateTimeFilter.closedAt.startAt, result.saved, (await lines()).length],
      expected: ['2026-01-06T15:00:00.000Z', 0, 2],
    });
  });

  test('a dry run', async () => {
    const result = await importSalesHistory(
      prisma,
      squareWith([squareOrder({ id: 'o-1', closedAt: '2026-01-05T15:00:00Z', lines: [{ uid: 'a', quantity: '1' }] })]).client,
      { save: false },
    );

    assert({
      given: 'an import without saving',
      should: 'count the lines and save none',
      actual: [result.lines, result.saved, (await lines()).length],
      expected: [1, 0, 0],
    });
  });
});

describe('salesVelocity (Postgres)', () => {
  test('history and live sales together', async () => {
    const productId = await product();
    await historyLine({ productId, locationId: centro, at: ago(10), quantity: 3 });
    await historyLine({ productId, locationId: centro, at: ago(5), quantity: -1 }); // a return in Square
    await historyLine({ productId, locationId: centro, at: ago(60), quantity: 5 });
    await historyLine({ productId, locationId: centro, at: ago(200), quantity: 7 });
    await historyLine({ productId, locationId: norte, at: ago(2), quantity: 9 });
    const sale = await liveSale({ productId, locationId: centro, at: ago(1), quantity: 2, paymentId: 'pay-live' });
    await historyLine({ productId, locationId: centro, at: ago(1), quantity: 2, paymentId: 'pay-live' }); // the same order, imported too
    await liveReturn(sale, 1, ago(0.5));

    assert({
      given: "a store's history, a live sale also imported, and returns in both",
      should: 'count each order once, net of returns, at that store only',
      actual: await salesVelocity(prisma, productId, centro, now),
      expected: { lastSoldAt: ago(1).toISOString(), unitsLast30d: 3, unitsLast90d: 8, daysSinceLastSale: 1 },
    });
  });

  test('a live sale and its live return, both imported too', async () => {
    const productId = await product();
    const sale = await liveSale({ productId, locationId: centro, at: ago(3), quantity: 2, paymentId: 'pay-ret' });
    await liveReturn(sale, 1, ago(2), 'square-return-line:ret-line');
    await historyLine({ productId, locationId: centro, at: ago(3), quantity: 2, paymentId: 'pay-ret' });
    // Square's return order has no tender; the worker recorded its line as the return above.
    await historyLine({ productId, locationId: centro, at: ago(2), quantity: -1, order: 'o-return', line: 'ret-line' });

    assert({
      given: 'a sale and its Square return, each recorded live and imported',
      should: 'count the 2 sold and the 1 returned once each',
      actual: (await salesVelocity(prisma, productId, centro, now)).unitsLast30d,
      expected: 1,
    });
  });

  test('an exchange recorded live and imported', async () => {
    const productId = await product();
    // The worker records what a customer took in an exchange as a sale keyed on the refund.
    await liveSale({ productId, locationId: centro, at: ago(2), quantity: 1, paymentId: 'refund-x' });
    await importSalesHistory(
      prisma,
      squareWith([squareOrder({ id: 'o-exchange', closedAt: ago(2).toISOString(), refundId: 'refund-x', lines: [{ uid: 'x', catalogObjectId: `v-${productId}`, quantity: '1' }] })]).client,
      { save: true },
    );

    assert({
      given: "an exchange's new line, recorded live as a sale keyed on its refund and imported too",
      should: 'count it once',
      actual: (await salesVelocity(prisma, productId, centro, now)).unitsLast30d,
      expected: 1,
    });
  });

  test('days since the last sale, by the store calendar', async () => {
    const productId = await product();
    // Sunday 2026-11-08 at 20:00 in Mexico City, read Monday at 08:00: 12 hours, but the day before.
    await historyLine({ productId, locationId: centro, at: new Date('2026-11-09T02:00:00Z'), quantity: 1 });

    assert({
      given: 'a sale last night, read this morning',
      should: 'say it sold 1 day ago',
      actual: (await salesVelocity(prisma, productId, centro, new Date('2026-11-09T14:00:00Z'))).daysSinceLastSale,
      expected: 1,
    });
  });

  test('a product never sold', async () => {
    const productId = await product();

    assert({
      given: 'a product with no sales at the store',
      should: 'say it has never sold',
      actual: await salesVelocity(prisma, productId, centro, now),
      expected: { lastSoldAt: null, unitsLast30d: 0, unitsLast90d: 0, daysSinceLastSale: null },
    });
  });
});

describe('busyHours (Postgres)', () => {
  test("orders by the store's day and hour", async () => {
    const productId = await product();
    // Monday 2026-11-02 09:15 and 09:40 in Mexico City (UTC−6); the first has two lines.
    await historyLine({ locationId: centro, at: new Date('2026-11-02T15:15:00Z'), quantity: 1, order: 'mon-1' });
    await historyLine({ productId, locationId: centro, at: new Date('2026-11-02T15:15:00Z'), quantity: 2, order: 'mon-1' });
    await historyLine({ locationId: centro, at: new Date('2026-11-02T15:40:00Z'), quantity: 1, order: 'mon-2' });
    // Saturday 2026-11-07 19:30 in Mexico City is already Sunday in UTC: one imported, one live,
    // and the live one imported too.
    await historyLine({ locationId: centro, at: new Date('2026-11-08T01:30:00Z'), quantity: 1, order: 'sat-1' });
    await liveSale({ productId, locationId: centro, at: new Date('2026-11-08T01:35:00Z'), quantity: 1, paymentId: 'pay-sat' });
    await historyLine({ productId, locationId: centro, at: new Date('2026-11-08T01:35:00Z'), quantity: 1, order: 'sat-2', paymentId: 'pay-sat' });
    // Monday 09:50: an order recorded live with only a custom amount (no item),
    // and Monday 09:55 a Yastás payment recorded live and imported too.
    await prisma.sale.create({ data: { squareId: 'pay-custom', locationId: centro, totalRevenue: 5, totalCost: 0, grossProfit: 5, createdAt: new Date('2026-11-02T15:50:00Z') } });
    const { id: employeeId } = await prisma.employee.create({ data: { name: `E-${Math.random()}` } });
    await prisma.yastasOperation.create({ data: { employeeId, locationId: centro, squareId: 'pay-yastas', squareLineUid: 'y', direction: 'IN', faceAmount: 100, occurredAt: new Date('2026-11-02T15:55:00Z') } });
    await historyLine({ locationId: centro, at: new Date('2026-11-02T15:55:00Z'), quantity: 1, order: 'mon-yastas', paymentId: 'pay-yastas' });
    // Saturday 19:40: one payment with a product and a Yastás line, recorded live as both.
    await liveSale({ productId, locationId: centro, at: new Date('2026-11-08T01:40:00Z'), quantity: 1, paymentId: 'pay-mixed' });
    await prisma.yastasOperation.create({ data: { employeeId, locationId: centro, squareId: 'pay-mixed', squareLineUid: 'y', direction: 'IN', faceAmount: 50, occurredAt: new Date('2026-11-08T01:40:00Z') } });
    // Left out: a return, an order older than the window, another store.
    await historyLine({ locationId: centro, at: new Date('2026-11-02T15:20:00Z'), quantity: -1, order: 'mon-return' });
    await historyLine({ locationId: centro, at: ago(120), quantity: 1 });
    await historyLine({ locationId: norte, at: new Date('2026-11-02T15:15:00Z'), quantity: 1 });

    assert({
      given: 'orders imported and recorded live over the last 90 days, including custom amounts and Yastás payments',
      should: 'count each order once in the hour it closed, on the store clock, whatever its lines, leaving out returns, older orders and other stores',
      actual: await busyHours(prisma, centro, 90, now),
      expected: {
        timezone: 'America/Mexico_City',
        cells: [
          { dayOfWeek: 1, hour: 9, orders: 4 },
          { dayOfWeek: 6, hour: 19, orders: 3 },
        ],
      },
    });
  });
});

describe('busyHours in summer (Postgres)', () => {
  test('an order when Chicago is on daylight time', async () => {
    // 2026-07-06 is a Monday: 14:15 UTC is 08:15 in Mexico City (no DST since 2022) but 09:15 in Chicago.
    await historyLine({ locationId: centro, at: new Date('2026-07-06T14:15:00Z'), quantity: 1 });

    assert({
      given: 'an order in July, when Square\'s Chicago clock is an hour ahead of Mexico City',
      should: 'count it in the hour it closed on the Mexico City clock the stores keep',
      actual: (await busyHours(prisma, centro, 365, now)).cells,
      expected: [{ dayOfWeek: 1, hour: 8, orders: 1 }],
    });
  });
});

describe('sales history endpoints (Postgres)', () => {
  const at = (locationId: string, role = 'MANAGER') =>
    ({ currentLocation: { locationId, role }, accessibleLocations: [{ locationId, isActive: true }] }) as any;
  const products = () => new ProductsController({} as any, prisma, {} as any, {} as any, {} as any);
  const reports = () => new InventoryReportsController(new InventoryReportsService(prisma));

  test('sales velocity at the session store', async () => {
    const productId = await product();
    const threeDaysAgo = new Date(Date.now() - 3 * DAY); // the endpoint reads up to the real clock
    await historyLine({ productId, locationId: centro, at: threeDaysAgo, quantity: 4 });
    await historyLine({ productId, locationId: norte, at: threeDaysAgo, quantity: 9 });

    const response = await products().getSalesVelocity(at(centro, 'CASHIER'), productId);

    assert({
      given: 'a request without a store',
      should: "answer with the product's velocity at the session's store",
      actual: [response.success, response.data.unitsLast30d],
      expected: [true, 4],
    });
  });

  test('sales velocity of a product that does not exist', async () => {
    const error = await products().getSalesVelocity(at(centro), 'no-such-product').catch((e) => e);

    assert({
      given: 'an unknown product id',
      should: 'refuse with 404',
      actual: error.getStatus?.(),
      expected: 404,
    });
  });

  test('busy hours over a number of days', async () => {
    await historyLine({ locationId: centro, at: new Date(Date.now() - 20 * DAY), quantity: 1 });
    const controller = reports();

    const outcomes = await Promise.all(
      [undefined, '10', '0', 'abc', '1.5', '800'].map((days) =>
        controller.getBusyHours(at(centro), undefined, days).then(
          (r) => r.data.cells.reduce((sum, c) => sum + c.orders, 0),
          (e) => e.getStatus(),
        ),
      ),
    );

    assert({
      given: 'no day count, a short one, and day counts that are not a whole number of days up to two years',
      should: 'count 90 days by default, the days asked for, and refuse the others with 400',
      actual: outcomes,
      expected: [1, 0, 400, 400, 400, 400],
    });
  });
});
