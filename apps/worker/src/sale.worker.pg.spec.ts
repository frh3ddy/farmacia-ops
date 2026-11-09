/**
 * processSaleJob against a real Postgres engine (PGlite with every migration),
 * so the FIFO deduction, shortfall cover and Yastás ledger run in a real
 * transaction. Prisma reaches PGlite through pglite-socket.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { Job } from 'bullmq';
import { getPrisma, processMatchJob, processRefundJob, processReturnJob, processSaleJob } from './sale.worker';
import { SaleValidationError } from './errors';
import { booksMismatches, loadBooks } from './books-check';
import { findSquareVariationId } from './catalog.mapper';

// The worker's moduleResolution can't see package subpath exports; Node's require can.
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');

// Returns push their stock change to Square; record the calls instead.
const batchCreateChanges = jest.fn(async (_request: unknown) => ({}));
// A refund's order is fetched from Square.
const getOrder = jest.fn(async (_request: { orderId: string }): Promise<{ order?: object }> => ({}));
jest.mock('./square-client', () => ({ getSquareClient: () => ({ inventory: { batchCreateChanges }, orders: { get: getOrder } }) }));

jest.setTimeout(120_000);

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');
let db: PGlite;
let server: PGLiteSocketServer;

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pg_trgm } });
  for (const dir of readdirSync(MIGRATIONS).filter((d) => !d.endsWith('.toml')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  }
  const port = 54_000 + Math.floor(Math.random() * 1_000);
  server = new PGLiteSocketServer({ db, port });
  await server.start();
  // PGlite is a single connection.
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  process.env.WORKER_DATABASE_POOL_MAX = '1';
});

afterAll(async () => {
  await getPrisma().$disconnect();
  // Stopping the server drops the pool's idle connection, which the worker logs.
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await server?.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await db?.close();
});

const job = (lineItems: object[], paymentId = 'p-1', squareLocationId = 'SQ-CENTRO', returns?: object[]) =>
  ({
    id: `evt-${paymentId}`,
    data: {
      payload: {
        object: { payment: { id: paymentId, location_id: squareLocationId, order_id: `o-${paymentId}`, created_at: '2026-10-27T18:00:00Z' } },
        _testOrderData: { id: `o-${paymentId}`, lineItems, returns },
      },
    },
  }) as unknown as Job;

// What came back, as Square's return order lists it: each line points at the sold line.
const returnLine = (uid: string, sourceLineItemUid: string, quantity: string, centavos: number) => ({
  uid,
  sourceLineItemUid,
  quantity,
  totalMoney: { amount: centavos, currency: 'MXN' },
});

const refundJob = (refund: { id: string; order_id: string; payment_id: string; amount: number; status?: string; reason?: string }) =>
  ({
    id: `evt-${refund.id}`,
    name: 'square-refund',
    data: {
      payload: {
        object: {
          refund: {
            id: refund.id,
            status: refund.status ?? 'COMPLETED',
            order_id: refund.order_id,
            payment_id: refund.payment_id,
            location_id: 'SQ-CENTRO',
            reason: refund.reason,
            amount_money: { amount: refund.amount, currency: 'MXN' },
            created_at: '2026-10-28T18:00:00Z',
          },
        },
      },
    },
  }) as unknown as Job;

const line = (catalogObjectId: string, quantity: string, centavos: number, uid = `uid-${catalogObjectId}`) => ({
  uid,
  catalogObjectId,
  quantity,
  totalMoney: { amount: centavos, currency: 'MXN' }, // job data is JSON, so a number
});

test('a sale across two batches, a product short of stock, and a Yastás line', async () => {
  const prisma = getPrisma();
  const location = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } });
  // Sales are recorded only after the store's cutover.
  await prisma.cutoverLock.create({ data: { locationId: location.id, cutoverDate: new Date('2026-09-01') } });
  const jarabe = await prisma.product.create({ data: { name: 'Jarabe' } });
  const gasas = await prisma.product.create({ data: { name: 'Gasas' } });
  const service = await prisma.product.create({ data: { name: 'Pago de luz', tracksInventory: false } });
  const employee = await prisma.employee.create({ data: { name: 'Ana' } });
  await prisma.catalogMapping.createMany({
    data: [
      { squareVariationId: 'v-jarabe', productId: jarabe.id },
      { squareVariationId: 'v-gasas', productId: gasas.id },
      { squareVariationId: 'v-luz', productId: service.id, employeeId: employee.id },
    ],
  });
  const wallet = await prisma.yastasWallet.create({ data: { locationId: location.id, balance: 1000 } });
  const batch = (productId: string, quantity: number, unitCost: number, receivedAt: string) =>
    prisma.inventory.create({ data: { productId, locationId: location.id, quantity, unitCost, receivedAt: new Date(receivedAt) } });
  // The newer batch is created first: FIFO goes by receivedAt, not creation order.
  const newer = await batch(jarabe.id, 2, 12, '2026-10-20');
  const older = await batch(jarabe.id, 1, 10, '2026-10-01');
  const gasasEmpty = await batch(gasas.id, 0, 7, '2026-09-01');

  // 2 jarabes for $90, 1 gasa for $20 (none in stock), a $250 electricity payment.
  const lines = [line('v-jarabe', '2', 9000), line('v-gasas', '1', 2000), line('v-luz', '1', 25000)];
  await processSaleJob(job(lines));

  const sale = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-1' }, include: { items: true } });
  const cover = await prisma.inventoryAdjustment.findFirstOrThrow({ where: { type: 'AUTO_SALE_COVER' } });
  const left = async (id: string) => (await prisma.inventory.findUniqueOrThrow({ where: { id } })).quantity;
  const operation = await prisma.yastasOperation.findFirstOrThrow({ where: { squareId: 'p-1' } });

  expect({
    revenue: sale.totalRevenue.toString(),
    // jarabe: 10 (older) + 12 (newer); gasas: 7, covered at its last batch's cost
    cost: sale.totalCost.toString(),
    items: sale.items.map((i) => [i.productId, i.quantity]).sort(),
    cover: { productId: cover.productId, quantity: cover.quantity, unitCost: cover.unitCost.toString() },
    left: { older: await left(older.id), newer: await left(newer.id), gasasEmpty: await left(gasasEmpty.id), cover: await left(cover.createdBatchId!) },
    yastas: { employeeId: operation.employeeId, faceAmount: operation.faceAmount.toString() },
    walletBalance: (await prisma.yastasWallet.findUniqueOrThrow({ where: { id: wallet.id } })).balance.toString(),
    books: booksMismatches(await loadBooks(prisma)),
  }).toEqual({
    revenue: '110',
    cost: '29',
    items: [[gasas.id, 1], [jarabe.id, 2]].sort(),
    cover: { productId: gasas.id, quantity: 1, unitCost: '7' },
    left: { older: 0, newer: 1, gasasEmpty: 0, cover: 0 },
    yastas: { employeeId: employee.id, faceAmount: '250' },
    walletBalance: '750',
    books: [],
  });

  // A redelivered webhook records nothing twice.
  await processSaleJob(job(lines));
  expect([await prisma.sale.count(), await prisma.inventoryConsumption.count(), await prisma.walletMovement.count()]).toEqual([1, 3, 1]);
});

test('an order with two Yastás lines', async () => {
  const prisma = getPrisma();
  const wallet = await prisma.yastasWallet.findFirstOrThrow();
  const before = wallet.balance;

  // Two electricity payments on one ticket: same item, two lines.
  const lines = [line('v-luz', '1', 25000, 'uid-luz-1'), line('v-luz', '1', 10000, 'uid-luz-2')];
  await processSaleJob(job(lines, 'p-2'));
  await processSaleJob(job(lines, 'p-2')); // redelivered

  const operations = await prisma.yastasOperation.findMany({ where: { squareId: 'p-2' }, include: { movements: true }, orderBy: { faceAmount: 'desc' } });
  expect({
    operations: operations.map((o) => [o.faceAmount.toString(), o.movements.map((m) => m.amount.toString())]),
    walletChange: (await prisma.yastasWallet.findUniqueOrThrow({ where: { id: wallet.id } })).balance.sub(before).toString(),
  }).toEqual({
    operations: [
      ['250', ['-250']],
      ['100', ['-100']],
    ],
    walletChange: '-350',
  });
});

test('a Yastás payment at a location with no wallet', async () => {
  const norte = await getPrisma().location.create({ data: { squareId: 'SQ-NORTE', name: 'Norte' } });
  await getPrisma().cutoverLock.create({ data: { locationId: norte.id, cutoverDate: new Date('2026-09-01') } });

  // A setup problem, not a database failure: it must keep its type.
  await expect(processSaleJob(job([line('v-luz', '1', 25000)], 'p-3', 'SQ-NORTE'))).rejects.toThrow(SaleValidationError);
});

test('an order of only custom amounts', async () => {
  const prisma = getPrisma();
  // Staff typed $16 with no description, and a 2 × $15 'crema roja'.
  const lines = [
    { uid: 'uid-c1', quantity: '1', totalMoney: { amount: 1600, currency: 'MXN' } },
    { uid: 'uid-c2', note: 'crema roja', quantity: '2', totalMoney: { amount: 3000, currency: 'MXN' } },
  ];
  await processSaleJob(job(lines, 'p-4'));
  await processSaleJob(job(lines, 'p-4')); // redelivered

  const sale = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-4' }, include: { items: true, unmatchedLines: true } });
  expect({
    revenue: sale.totalRevenue.toString(),
    cost: sale.totalCost.toString(),
    profit: sale.grossProfit.toString(),
    items: sale.items.length,
    pending: sale.unmatchedLines.map((l) => [l.squareLineUid, l.description, l.quantity, l.amount.toString()]).sort(),
    books: booksMismatches(await loadBooks(prisma)),
  }).toEqual({
    revenue: '46',
    cost: '0',
    profit: '46',
    items: 0,
    pending: [
      ['uid-c1', null, 1, '16'],
      ['uid-c2', 'crema roja', 2, '30'],
    ],
    books: [],
  });
});

test('matching a custom amount to a product', async () => {
  const prisma = getPrisma();
  const sale = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-4' } });
  const crema = await prisma.unmatchedSaleLine.findFirstOrThrow({ where: { squareLineUid: 'uid-c2' } });
  const product = await prisma.product.create({ data: { name: 'Crema roja' } });
  const batch = await prisma.inventory.create({
    data: { productId: product.id, locationId: sale.locationId, quantity: 5, unitCost: 6, receivedAt: new Date('2026-10-01') },
  });
  const match = { id: 'match-1', name: 'match-sale-line', data: { lineId: crema.id, productId: product.id, matchedBy: 'emp-mgr' } } as unknown as Job;

  await processMatchJob(match);
  await processMatchJob(match); // a second click, or a retried job

  const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { items: true } });
  const line = await prisma.unmatchedSaleLine.findUniqueOrThrow({ where: { id: crema.id } });
  expect({
    // revenue was counted when the sale arrived; matching adds only the cost
    revenue: after.totalRevenue.toString(),
    cost: after.totalCost.toString(),
    profit: after.grossProfit.toString(),
    items: after.items.map((i) => [i.productId, i.quantity, i.price.toString(), i.cost.toString()]),
    line: { matched: line.matchedSaleItemId === after.items[0]?.id, matchedBy: line.matchedBy },
    stockLeft: (await prisma.inventory.findUniqueOrThrow({ where: { id: batch.id } })).quantity,
    books: booksMismatches(await loadBooks(prisma)),
  }).toEqual({
    revenue: '46',
    cost: '12',
    profit: '34',
    items: [[product.id, 2, '15', '12']],
    line: { matched: true, matchedBy: 'emp-mgr' },
    stockLeft: 3,
    books: [],
  });
});

test('a customer returns one of two jarabes', async () => {
  const prisma = getPrisma();
  // p-1 sold 2 jarabes for $90 at a cost of 10 + 12, and 1 gasa.
  const sale = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-1' }, include: { items: { include: { product: true } } } });
  const jarabe = sale.items.find((i) => i.product.name === 'Jarabe')!;
  const returnJob = (quantity: number, clientRequestId: string) =>
    ({
      id: clientRequestId,
      name: 'record-return',
      data: { saleId: sale.id, items: [{ saleItemId: jarabe.id, quantity }], reason: 'Caducidad cercana', returnedBy: 'emp-cajera', clientRequestId },
    }) as unknown as Job;

  await processReturnJob(returnJob(1, 'r-1'));
  await processReturnJob(returnJob(1, 'r-1')); // resent

  const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
  const returns = await prisma.saleReturn.findMany({ where: { saleId: sale.id }, include: { items: { include: { adjustment: { include: { createdBatch: true } } } } } });
  const item = returns[0]?.items[0];
  expect({
    // paid back in cash outside Square, so the cash drawer can be squared
    returns: returns.map((r) => [r.returnedBy, r.reason, r.revenue.toString(), r.cost.toString(), r.cashRefunded?.toString()]),
    // one unit back at the item's average sold cost (22 / 2), as the newest batch
    restocked: item && [item.quantity, item.adjustment.type, item.adjustment.createdBatch?.quantity, item.adjustment.createdBatch?.unitCost.toString()],
    // a return counts in its own month: the sale stays as sold
    sale: [after.totalRevenue.toString(), after.totalCost.toString(), after.grossProfit.toString()],
    books: booksMismatches(await loadBooks(prisma)),
  }).toEqual({
    returns: [['emp-cajera', 'Caducidad cercana', '45', '11', '45']],
    restocked: [1, 'RETURN', 1, '11'],
    sale: [sale.totalRevenue.toString(), sale.totalCost.toString(), sale.grossProfit.toString()],
    books: [],
  });

  // Only one jarabe is left to return.
  await expect(processReturnJob(returnJob(2, 'r-2'))).rejects.toThrow(new SaleValidationError('Solo quedan 1 de Jarabe por devolver'));
});

test('a return listing the same item twice', async () => {
  const prisma = getPrisma();
  // p-1's other jarabe is the only one left.
  const sale = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-1' }, include: { items: { include: { product: true } } } });
  const jarabe = sale.items.find((i) => i.product.name === 'Jarabe')!;
  const twice = { saleItemId: jarabe.id, quantity: 1 };
  const job = { id: 'r-twice', name: 'record-return', data: { saleId: sale.id, items: [twice, twice], returnedBy: 'emp-owner', clientRequestId: 'r-twice' } } as unknown as Job;

  await expect(processReturnJob(job)).rejects.toThrow(new SaleValidationError('Solo quedan 1 de Jarabe por devolver'));
  expect(await prisma.saleReturn.count({ where: { clientRequestId: 'r-twice' } })).toBe(0);
});

test('a return puts the units back in Square, once, retrying when Square fails', async () => {
  const prisma = getPrisma();
  const sale = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-1' }, include: { items: { include: { product: true } } } });
  const gasas = sale.items.find((i) => i.product.name === 'Gasas')!;
  const job = { id: 'r-3', name: 'record-return', data: { saleId: sale.id, items: [{ saleItemId: gasas.id, quantity: 1 }], returnedBy: 'emp-cajera', clientRequestId: 'r-3' } } as unknown as Job;
  batchCreateChanges.mockClear();
  batchCreateChanges.mockRejectedValueOnce(new Error('Square is down'));

  await expect(processReturnJob(job)).rejects.toThrow('Square is down'); // BullMQ retries the job
  const failed = await prisma.saleReturnItem.findFirstOrThrow({ where: { saleItemId: gasas.id }, include: { adjustment: true } });
  await processReturnJob(job); // the retry
  await processReturnJob(job); // a later resend

  const adjustment = await prisma.inventoryAdjustment.findUniqueOrThrow({ where: { id: failed.adjustmentId } });
  expect({
    calls: batchCreateChanges.mock.calls.length,
    request: batchCreateChanges.mock.calls[1]?.[0],
    afterFailure: [failed.adjustment.squareSynced, failed.adjustment.squareSyncError],
    synced: [adjustment.squareSynced, adjustment.squareSyncError],
    returns: await prisma.saleReturn.count({ where: { clientRequestId: 'r-3' } }),
  }).toEqual({
    calls: 2,
    // keyed on the adjustment, like the api's adjustments, so a retry never doubles the stock
    request: {
      idempotencyKey: adjustment.id,
      changes: [
        {
          type: 'ADJUSTMENT',
          adjustment: {
            catalogObjectId: 'v-gasas',
            fromLocationId: 'SQ-CENTRO',
            toLocationId: 'SQ-CENTRO',
            quantity: '1',
            fromState: 'UNLINKED_RETURN',
            toState: 'IN_STOCK',
            occurredAt: adjustment.adjustedAt.toISOString(),
            referenceId: `adjustment-RETURN-${adjustment.id}`,
          },
        },
      ],
    },
    afterFailure: [false, 'Square is down'],
    synced: [true, null],
    returns: 1,
  });
});

test('an exchange where the customer pays the difference', async () => {
  const prisma = getPrisma();
  // p-1 sold 2 jarabes at $45 (one already returned by hand). The customer brings
  // the other back and takes pastillas for $60, paying $15: Square sends one
  // payment whose order lists the pastillas and, under returns, the jarabe.
  const p1 = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-1' } });
  const pastillas = await prisma.product.create({ data: { name: 'Pastillas' } });
  await prisma.catalogMapping.create({ data: { squareVariationId: 'v-pastillas', productId: pastillas.id } });
  await prisma.inventory.create({ data: { productId: pastillas.id, locationId: p1.locationId, quantity: 5, unitCost: 20, receivedAt: new Date('2026-10-01') } });
  const exchange = job([line('v-pastillas', '1', 6000)], 'p-5', 'SQ-CENTRO', [
    { uid: 'ret-1', returnLineItems: [returnLine('rli-1', 'uid-v-jarabe', '1', 4500)] },
  ]);
  batchCreateChanges.mockClear();

  await processSaleJob(exchange);
  await processSaleJob(exchange); // redelivered

  const p5 = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-5' } });
  const p1After = await prisma.sale.findUniqueOrThrow({ where: { id: p1.id } });
  const back = await prisma.saleReturn.findUniqueOrThrow({ where: { clientRequestId: 'square-return-line:rli-1' }, include: { items: { include: { adjustment: true } } } });
  expect({
    newSale: [p5.totalRevenue.toString(), p5.totalCost.toString()],
    // the jarabe comes back at its sold price and cost (22 / 2); p-1 stays as sold, and Square paid it back
    original: [p1After.totalRevenue.toString(), p1After.totalCost.toString()],
    back: [back.revenue.toString(), back.cost.toString(), back.cashRefunded, ...back.items.map((i) => [i.quantity, i.adjustment.type, i.adjustment.squareSynced])],
    // Square restocked it itself
    squareCalls: batchCreateChanges.mock.calls.length,
    books: booksMismatches(await loadBooks(prisma)),
  }).toEqual({
    newSale: ['60', '20'],
    original: [p1.totalRevenue.toString(), p1.totalCost.toString()],
    back: ['45', '11', null, [1, 'RETURN', true]],
    squareCalls: 0,
    books: [],
  });
});

test('a Square refund: a matched and an unmatched custom amount back, and an exchange item out', async () => {
  const prisma = getPrisma();
  // p-4 sold a $16 custom amount (still unmatched) and 2 crema roja at $15 (matched, cost 6 each).
  const p4 = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-4' } });
  getOrder.mockResolvedValue({
    order: {
      id: 'ro-1',
      lineItems: [line('v-pastillas', '1', 2000)],
      returns: [{ returnLineItems: [returnLine('rli-2', 'uid-c1', '1', 1600), returnLine('rli-3', 'uid-c2', '1', 1500)] }],
    },
  });
  const refund = refundJob({ id: 'rf-1', order_id: 'ro-1', payment_id: 'p-4', amount: 1100, reason: 'Cambio de producto' });

  await processRefundJob(refund);
  await processRefundJob(refund); // refund.created and refund.updated both arrive

  const p4After = await prisma.sale.findUniqueOrThrow({ where: { id: p4.id } });
  const returns = await prisma.saleReturn.findMany({ where: { saleId: p4.id }, include: { items: true }, orderBy: { revenue: 'asc' } });
  const exchange = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'rf-1' } });
  expect({
    returns: returns.map((r) => [r.reason, r.revenue.toString(), r.cost.toString(), r.cashRefunded, r.items.length]),
    original: [p4After.totalRevenue.toString(), p4After.totalCost.toString()],
    exchange: [exchange.totalRevenue.toString(), exchange.totalCost.toString()],
    books: booksMismatches(await loadBooks(prisma)),
  }).toEqual({
    // the matched crema goes back to stock; the unmatched $16 only takes revenue back
    returns: [
      ['Cambio de producto', '15', '6', null, 1],
      ['Cambio de producto', '16', '0', null, 0],
    ],
    original: [p4.totalRevenue.toString(), p4.totalCost.toString()],
    exchange: ['20', '20'],
    books: [],
  });
});

test('an amount-only refund, a refund still pending, and a return of a sale never recorded', async () => {
  const prisma = getPrisma();
  const p5 = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-5' } });
  getOrder.mockResolvedValue({ order: { id: 'ro-2' } });
  const refund = refundJob({ id: 'rf-2', order_id: 'ro-2', payment_id: 'p-5', amount: 500, reason: 'Cobro accidental' });

  await processRefundJob(refund);
  await processRefundJob(refund);
  await processRefundJob(refundJob({ id: 'rf-3', order_id: 'ro-2', payment_id: 'p-5', amount: 900, status: 'PENDING' }));
  // sold before sales were recorded: nothing to take it from
  getOrder.mockResolvedValue({ order: { id: 'ro-4', returns: [{ returnLineItems: [returnLine('rli-4', 'uid-unknown', '1', 900)] }] } });
  await processRefundJob(refundJob({ id: 'rf-4', order_id: 'ro-4', payment_id: 'p-old', amount: 900 }));

  const after = await prisma.sale.findUniqueOrThrow({ where: { id: p5.id } });
  const returns = await prisma.saleReturn.findMany({ where: { saleId: p5.id } });
  expect({
    sale: after.totalRevenue.toString(),
    returns: returns.map((r) => [r.revenue.toString(), r.cost.toString(), r.cashRefunded]),
    unknown: await prisma.saleReturn.count({ where: { clientRequestId: 'square-return-line:rli-4' } }),
  }).toEqual({ sale: p5.totalRevenue.toString(), returns: [['5', '0', null]], unknown: 0 });
});

test('a Square refund repeating a line already returned, and a line with no uid', async () => {
  const prisma = getPrisma();
  const p4 = await prisma.sale.findUniqueOrThrow({ where: { squareId: 'p-4' } });
  getOrder.mockResolvedValue({
    order: {
      id: 'ro-5',
      returns: [
        {
          returnLineItems: [
            returnLine('rli-5', 'uid-v-jarabe', '1', 4500),
            { ...returnLine('rli-x', 'uid-c2', '1', 1500), uid: undefined },
            returnLine('rli-6', 'uid-c2', '1', 1500),
          ],
        },
      ],
    },
  });

  await processRefundJob(refundJob({ id: 'rf-5', order_id: 'ro-5', payment_id: 'p-1', amount: 6000 }));

  expect({
    jarabe: await prisma.saleReturn.count({ where: { clientRequestId: 'square-return-line:rli-5' } }),
    noUid: await prisma.saleReturn.count({ where: { clientRequestId: 'square-return-line:undefined' } }),
    // the rest of the refund is still taken back
    crema: (await prisma.saleReturn.findUnique({ where: { clientRequestId: 'square-return-line:rli-6' } }))?.revenue.toString(),
  }).toEqual({ jarabe: 0, noUid: 0, crema: '15' });
});

test("a return's Square item, with a local_ placeholder mapping beside the real one", async () => {
  const prisma = getPrisma();
  const location = await prisma.location.findFirstOrThrow({ where: { squareId: 'SQ-CENTRO' } });
  const mapped = await prisma.product.create({ data: { name: 'Vendas' } });
  // Written for Centro's price; the real item is global.
  await prisma.catalogMapping.create({ data: { squareVariationId: `local_${mapped.id}`, productId: mapped.id, locationId: location.id } });
  await prisma.catalogMapping.create({ data: { squareVariationId: 'v-vendas', productId: mapped.id } });
  const unmapped = await prisma.product.create({ data: { name: 'Curitas' } });
  await prisma.catalogMapping.create({ data: { squareVariationId: `local_${unmapped.id}`, productId: unmapped.id, locationId: location.id } });

  expect({
    mapped: await findSquareVariationId(prisma, mapped.id, location.id),
    unmapped: await findSquareVariationId(prisma, unmapped.id, location.id),
  }).toEqual({ mapped: 'v-vendas', unmapped: null });
});

describe('sales and the store cutover', () => {
  /** What a payment left behind at a store: sales, stock, adjustments and Yastás operations. */
  const recordedAt = async (squareId: string, paymentId: string) => {
    const prisma = getPrisma();
    const location = await prisma.location.findUnique({ where: { squareId } });
    return {
      sales: await prisma.sale.count({ where: { squareId: paymentId } }),
      stock: location ? await prisma.inventory.count({ where: { locationId: location.id } }) : 0,
      adjustments: location ? await prisma.inventoryAdjustment.count({ where: { locationId: location.id } }) : 0,
      yastas: await prisma.yastasOperation.count({ where: { squareId: paymentId } }),
    };
  };
  const nothing = { sales: 0, stock: 0, adjustments: 0, yastas: 0 };

  test('a payment at a store with no cutover', async () => {
    const prisma = getPrisma();
    const sur = await prisma.location.create({ data: { squareId: 'SQ-SUR', name: 'Sur' } });
    await prisma.yastasWallet.create({ data: { locationId: sur.id, balance: 1000 } });

    const error = await processSaleJob(job([line('v-jarabe', '1', 2000), line('v-luz', '1', 5000)], 'p-sur', 'SQ-SUR')).catch((e: Error) => e);

    expect({ error: error instanceof SaleValidationError, recorded: await recordedAt('SQ-SUR', 'p-sur') })
      .toEqual({ error: true, recorded: nothing });
  });

  test('a payment from a Square location the app does not know', async () => {
    const error = await processSaleJob(job([line('v-jarabe', '1', 2000)], 'p-unknown', 'SQ-UNKNOWN')).catch((e: Error) => e);

    expect({
      error: error instanceof SaleValidationError,
      store: await getPrisma().location.count({ where: { squareId: 'SQ-UNKNOWN' } }),
      recorded: await recordedAt('SQ-UNKNOWN', 'p-unknown'),
    }).toEqual({ error: true, store: 0, recorded: nothing });
  });

  test('a payment dated before the store cutover', async () => {
    const prisma = getPrisma();
    const poniente = await prisma.location.create({ data: { squareId: 'SQ-PONIENTE', name: 'Poniente' } });
    // Counted the day after the payment (2026-10-27): the count already reflects it.
    await prisma.cutoverLock.create({ data: { locationId: poniente.id, cutoverDate: new Date('2026-10-28') } });

    await processSaleJob(job([line('v-jarabe', '1', 2000)], 'p-poniente', 'SQ-PONIENTE'));

    expect(await recordedAt('SQ-PONIENTE', 'p-poniente')).toEqual(nothing);
  });

  test('a cutover that covers every store', async () => {
    const prisma = getPrisma();
    const oriente = await prisma.location.create({ data: { squareId: 'SQ-ORIENTE', name: 'Oriente' } });
    const jarabe = await prisma.product.findFirstOrThrow({ where: { name: 'Jarabe' } });
    await prisma.inventory.create({ data: { productId: jarabe.id, locationId: oriente.id, quantity: 3, unitCost: 10, receivedAt: new Date('2026-09-01') } });
    await prisma.cutoverLock.create({ data: { locationId: null, cutoverDate: new Date('2026-09-01') } });

    await processSaleJob(job([line('v-jarabe', '1', 2000)], 'p-oriente', 'SQ-ORIENTE'));

    expect((await recordedAt('SQ-ORIENTE', 'p-oriente')).sales).toBe(1);
  });
});

describe('the payment a sale job carries', () => {
  const paymentJob = (payload: object) => ({ id: 'evt-shape', data: { payload } }) as unknown as Job;

  test('a payment anywhere but payload.object.payment', async () => {
    const payment = { id: 'p-shape', location_id: 'SQ-CENTRO', order_id: 'o-shape', created_at: '2026-10-27T18:00:00Z' };
    const errors = await Promise.all([
      processSaleJob(paymentJob({ object: payment, _testOrderData: { id: 'o-shape', lineItems: [line('v-jarabe', '1', 2000)] } })).catch((e: Error) => e),
      processSaleJob(paymentJob({ ...payment, _testOrderData: { id: 'o-shape', lineItems: [line('v-jarabe', '1', 2000)] } })).catch((e: Error) => e),
    ]);

    expect({
      refused: errors.map((e) => e instanceof SaleValidationError && e.message),
      sales: await getPrisma().sale.count({ where: { squareId: 'p-shape' } }),
    }).toEqual({ refused: ['Sale validation error: Missing payment object in payload', 'Sale validation error: Missing payment object in payload'], sales: 0 });
  });

  test('a refused payment', async () => {
    const error = await processSaleJob(paymentJob({ object: { payment: { id: 'p-noloc', order_id: 'o-noloc', card_details: { last_4: '4242' } } } }))
      .then(() => undefined, (e: SaleValidationError) => e);

    // failed-job.ts: a sale job holds the Square payment (card details, buyer email); never keep it.
    expect([error?.message, error?.context]).toEqual(['Sale validation error: Payment object missing location_id', { paymentId: 'p-noloc' }]);
  });
});

test("a sale's batch consumptions, each at its own batch's cost", async () => {
  const prisma = getPrisma();
  const centro = await prisma.location.findFirstOrThrow({ where: { squareId: 'SQ-CENTRO' } });
  const suero = await prisma.product.create({ data: { name: 'Suero' } });
  await prisma.catalogMapping.create({ data: { squareVariationId: 'v-suero', productId: suero.id } });
  const older = await prisma.inventory.create({ data: { productId: suero.id, locationId: centro.id, quantity: 1, unitCost: 7, receivedAt: new Date('2026-09-10') } });
  const newer = await prisma.inventory.create({ data: { productId: suero.id, locationId: centro.id, quantity: 5, unitCost: 9.5, receivedAt: new Date('2026-10-10') } });

  await processSaleJob(job([line('v-suero', '3', 9000)], 'p-suero'));

  const consumed = await prisma.inventoryConsumption.findMany({ where: { inventoryId: { in: [older.id, newer.id] } } });
  expect(consumed.map((c) => [c.inventoryId, c.quantity, c.unitCost.toString(), c.totalCost.toString()]).sort()).toEqual(
    [[older.id, 1, '7', '7'], [newer.id, 2, '9.5', '19']].sort(),
  );
});

test('a sale of a product whose stock a Conteo inicial split into lots', async () => {
  const prisma = getPrisma();
  const location = await prisma.location.create({ data: { squareId: 'SQ-LOTS', name: 'Lolita' } });
  await prisma.cutoverLock.create({ data: { locationId: location.id, cutoverDate: new Date('2026-09-01') } });
  const product = await prisma.product.create({ data: { name: 'Amoxicilina' } });
  await prisma.catalogMapping.create({ data: { squareVariationId: 'v-amox', productId: product.id } });
  // As a count with lots leaves them: one batch's units split into a piece a millisecond
  // later, the soonest caducidad on the older one. The later piece is created first.
  const receivedAt = new Date('2026-10-01T12:00:00.000Z');
  const original = await prisma.inventory.create({
    data: { productId: product.id, locationId: location.id, quantity: 3, unitCost: 10, receivedAt, expiryDate: new Date('2027-01-01T18:00:00Z'), splitOut: 6 },
  });
  await prisma.inventory.create({
    data: {
      productId: product.id, locationId: location.id, quantity: 6, unitCost: 10, receivedAt: new Date(receivedAt.getTime() + 1),
      expiryDate: new Date('2027-03-01T18:00:00Z'), splitFromId: original.id, splitInitialQuantity: 6,
    },
  });

  await processSaleJob(job([line('v-amox', '2', 6000)], 'p-lots', 'SQ-LOTS'));
  const left = await prisma.inventory.findMany({ where: { productId: product.id }, orderBy: { receivedAt: 'asc' } });

  // given a sale of 2 after a count put 3 units of ene-2027 and 6 of mar-2027 on the shelf
  // should take the 2 from the soonest caducidad
  expect(left.map((b) => [b.expiryDate?.toISOString().slice(0, 7), b.quantity])).toEqual([
    ['2027-01', 1],
    ['2027-03', 6],
  ]);
});

describe('a sale short of sueltos with a box in stock', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  /** A cut-over store with a suelto (mapped to `v-<tag>`), linked to a box of 10 that has 2 in stock. */
  async function sueltoStore(tag: string, looseStock = 0) {
    const prisma = getPrisma();
    const location = await prisma.location.create({ data: { squareId: `SQ-${tag}`, name: tag } });
    await prisma.cutoverLock.create({ data: { locationId: location.id, cutoverDate: new Date('2026-09-01') } });
    const suelto = await prisma.product.create({ data: { name: `Suelto ${tag}` } });
    const box = await prisma.product.create({ data: { name: `Caja ${tag}`, quantity: 10 } });
    await prisma.productLooseLink.create({ data: { locationId: location.id, boxProductId: box.id, looseProductId: suelto.id } });
    await prisma.catalogMapping.create({ data: { squareVariationId: `v-${tag}`, productId: suelto.id } });
    await prisma.inventory.create({ data: { productId: box.id, locationId: location.id, quantity: 2, unitCost: 20, receivedAt: new Date('2026-10-01') } });
    // Last known cost for a cover: $5 a piece, so a made-up batch shows in the cost.
    if (looseStock) await prisma.inventory.create({ data: { productId: suelto.id, locationId: location.id, quantity: looseStock, unitCost: 5, receivedAt: new Date('2026-10-01') } });
    else await prisma.inventory.create({ data: { productId: suelto.id, locationId: location.id, quantity: 0, unitCost: 5, receivedAt: new Date('2026-09-15') } });
    process.env.API_INTERNAL_URL = 'http://api.test';
    process.env.WORKER_API_SECRET = 'worker-secret';
    return { prisma, location, suelto, box };
  }

  /** Stands in for the api's cover-loose: opens one box as 10 sueltos at $2, as the real one writes it. */
  function apiThatOpens(locationId: string, sueltoId: string, then: 'answer' | 'lose the reply' = 'answer') {
    return jest.fn(async (_url: string, init: { body: string }) => {
      const { requestKey } = JSON.parse(init.body);
      const prisma = getPrisma();
      const batch = await prisma.inventory.create({ data: { productId: sueltoId, locationId, quantity: 10, unitCost: 2, receivedAt: new Date() } });
      await prisma.inventoryAdjustment.create({
        data: { locationId, productId: sueltoId, type: 'BREAK_BULK_IN', quantity: 10, unitCost: 2, totalCost: 20, createdBatchId: batch.id, clientRequestId: `auto-open:${requestKey}:in` },
      });
      if (then === 'lose the reply') throw new Error('socket hang up');
      return { ok: true, status: 201, json: async () => ({ success: true, data: { boxesOpened: 1 } }) };
    });
  }

  const failingApi = () => jest.fn(async () => { throw new Error('connect ECONNREFUSED'); });
  const lastTry = (j: Job) => Object.assign(j, { attemptsMade: 2, opts: { attempts: 3 } });
  const earlierTry = (j: Job) => Object.assign(j, { attemptsMade: 0, opts: { attempts: 3 } });
  const covers = (productId: string) => getPrisma().inventoryAdjustment.findMany({ where: { productId, type: 'AUTO_SALE_COVER' } });
  const stock = async (productId: string, locationId: string) =>
    (await getPrisma().inventory.aggregate({ where: { productId, locationId }, _sum: { quantity: true } }))._sum.quantity;

  test('two lines of the same suelto, none in stock', async () => {
    const { location, suelto } = await sueltoStore('SUELTO1');
    const api = apiThatOpens(location.id, suelto.id);
    global.fetch = api as any;

    await processSaleJob(job([line('v-SUELTO1', '1', 1000, 'a'), line('v-SUELTO1', '2', 2000, 'b')], 'p-suelto1', 'SQ-SUELTO1'));
    const sale = await getPrisma().sale.findUniqueOrThrow({ where: { squareId: 'p-suelto1' } });
    const [url, init] = api.mock.calls[0] as any;

    // given a sale of 1 + 2 sueltos with none in stock and a box of 10
    // should ask the api once for the 3, with the secret, and cost the sale from the opened box
    expect({
      calls: api.mock.calls.length,
      url,
      secret: init.headers['x-worker-secret'],
      body: JSON.parse(init.body),
      cost: sale.totalCost.toString(),
      covers: (await covers(suelto.id)).length,
      left: await stock(suelto.id, location.id),
    }).toEqual({
      calls: 1,
      url: 'http://api.test/internal/inventory/cover-loose',
      secret: 'worker-secret',
      body: { locationId: location.id, looseProductId: suelto.id, needed: 3, requestKey: `p-suelto1:${suelto.id}` },
      cost: '6',
      covers: 0,
      left: 7,
    });
  });

  test('a suelto paired with a box only at another store', async () => {
    const { prisma, location, suelto, box } = await sueltoStore('SUELTO9');
    const other = await prisma.location.create({ data: { squareId: 'SQ-OTHER9', name: 'Otra' } });
    await prisma.productLooseLink.update({ where: { locationId_boxProductId: { locationId: location.id, boxProductId: box.id } }, data: { locationId: other.id } });
    const api = apiThatOpens(location.id, suelto.id);
    global.fetch = api as any;

    await processSaleJob(job([line('v-SUELTO9', '3', 3000)], 'p-suelto9', 'SQ-SUELTO9'));

    // given a sale short on a product that is a suelto only at another store
    // should not ask the api to open a box, and record the sale as before
    expect({ calls: api.mock.calls.length, recorded: !!(await prisma.sale.findUnique({ where: { squareId: 'p-suelto9' } })) }).toEqual({ calls: 0, recorded: true });
  });

  test('sueltos in stock that cover the sale', async () => {
    const { suelto } = await sueltoStore('SUELTO2', 5);
    const api = apiThatOpens('unused', suelto.id);
    global.fetch = api as any;

    await processSaleJob(job([line('v-SUELTO2', '3', 3000)], 'p-suelto2', 'SQ-SUELTO2'));

    // given a sale the sueltos on the shelf already cover
    // should not call the api
    expect(api).not.toHaveBeenCalled();
  });

  test('the api failing on a try that is not the last', async () => {
    await sueltoStore('SUELTO3');
    global.fetch = failingApi() as any;

    const outcome = await processSaleJob(earlierTry(job([line('v-SUELTO3', '3', 3000)], 'p-suelto3', 'SQ-SUELTO3'))).then(() => 'recorded', () => 'failed');

    // given the api unreachable with tries left
    // should fail the job so it retries, recording nothing
    expect([outcome, await getPrisma().sale.count({ where: { squareId: 'p-suelto3' } })]).toEqual(['failed', 0]);
  });

  test('the api failing on the last try', async () => {
    const { suelto } = await sueltoStore('SUELTO4');
    global.fetch = failingApi() as any;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await processSaleJob(lastTry(job([line('v-SUELTO4', '3', 3000)], 'p-suelto4', 'SQ-SUELTO4')));
    const [cover] = await covers(suelto.id);
    const warned = warn.mock.calls.some(([m]) => String(m).includes('p-suelto4'));
    warn.mockRestore();

    // given the api unreachable on the job's last try
    // should record the sale with today's cover, labeled as a box not opened, and warn
    expect([cover?.quantity, cover?.notes?.includes('api no disponible'), warned]).toEqual([3, true, true]);
  });

  test('the api opening the box but its reply lost', async () => {
    const { location, suelto } = await sueltoStore('SUELTO5');
    global.fetch = apiThatOpens(location.id, suelto.id, 'lose the reply') as any;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = await processSaleJob(earlierTry(job([line('v-SUELTO5', '3', 3000)], 'p-suelto5', 'SQ-SUELTO5'))).then(() => 'recorded', () => 'failed');
    const sale = await getPrisma().sale.findUniqueOrThrow({ where: { squareId: 'p-suelto5' } });
    const warned = warn.mock.calls.some(([m]) => String(m).includes('p-suelto5'));
    warn.mockRestore();

    // given the api committed the opening but the worker never got the answer, with tries left
    // should find the opening and sell from it now: no retry, no warning, nothing covered
    expect([outcome, warned, sale.totalCost.toString(), (await covers(suelto.id)).length, await stock(suelto.id, location.id)]).toEqual(['recorded', false, '6', 0, 7]);
  });

  test('a sale dated before the store cutover', async () => {
    const { location, suelto } = await sueltoStore('SUELTO7');
    // The payment is from 2026-10-27; this store was cut over after it.
    await getPrisma().cutoverLock.updateMany({ where: { locationId: location.id }, data: { cutoverDate: new Date('2026-12-01') } });
    const api = apiThatOpens(location.id, suelto.id);
    global.fetch = api as any;

    await processSaleJob(job([line('v-SUELTO7', '3', 3000)], 'p-suelto7', 'SQ-SUELTO7')).catch(() => undefined);

    // given a suelto sale the store's cutover means is never recorded
    // should open no box for it
    expect(api).not.toHaveBeenCalled();
  });

  test('a store with no box in stock for the suelto', async () => {
    const { location, suelto, box } = await sueltoStore('SUELTO6');
    await getPrisma().inventory.updateMany({ where: { productId: box.id }, data: { quantity: 0 } });
    global.fetch = jest.fn(async () => ({ ok: true, status: 201, json: async () => ({ success: true, data: { boxesOpened: 0 } }) })) as any;

    await processSaleJob(job([line('v-SUELTO6', '3', 3000)], 'p-suelto6', 'SQ-SUELTO6'));
    const [cover] = await covers(suelto.id);

    // given the api opening nothing because no box has stock
    // should cover the shortfall as today, labeled why
    expect([cover?.quantity, cover?.notes?.includes('sin caja con existencias'), await stock(suelto.id, location.id)]).toEqual([3, true, 0]);
  });
});
