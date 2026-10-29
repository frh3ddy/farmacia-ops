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
  await getPrisma().location.create({ data: { squareId: 'SQ-NORTE', name: 'Norte' } });

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
    returns: returns.map((r) => [r.returnedBy, r.reason, r.revenue.toString(), r.cost.toString()]),
    // one unit back at the item's average sold cost (22 / 2), as the newest batch
    restocked: item && [item.quantity, item.adjustment.type, item.adjustment.createdBatch?.quantity, item.adjustment.createdBatch?.unitCost.toString()],
    sale: [after.totalRevenue.toString(), after.totalCost.toString(), after.grossProfit.toString()],
    books: booksMismatches(await loadBooks(prisma)),
  }).toEqual({
    returns: [['emp-cajera', 'Caducidad cercana', '45', '11']],
    restocked: [1, 'RETURN', 1, '11'],
    sale: [String(Number(sale.totalRevenue) - 45), String(Number(sale.totalCost) - 11), String(Number(sale.grossProfit) - 34)],
    books: [],
  });

  // Only one jarabe is left to return.
  await expect(processReturnJob(returnJob(2, 'r-2'))).rejects.toThrow(SaleValidationError);
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
    // the jarabe comes off p-1 at its sold price and cost (22 / 2)
    original: [Number(p1.totalRevenue) - Number(p1After.totalRevenue), Number(p1.totalCost) - Number(p1After.totalCost)],
    back: back.items.map((i) => [i.quantity, i.adjustment.type, i.adjustment.squareSynced]),
    // Square restocked it itself
    squareCalls: batchCreateChanges.mock.calls.length,
    books: booksMismatches(await loadBooks(prisma)),
  }).toEqual({
    newSale: ['60', '20'],
    original: [45, 11],
    back: [[1, 'RETURN', true]],
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
    returns: returns.map((r) => [r.reason, r.revenue.toString(), r.cost.toString(), r.items.length]),
    original: [p4After.totalRevenue.toString(), p4After.totalCost.toString()],
    exchange: [exchange.totalRevenue.toString(), exchange.totalCost.toString()],
    books: booksMismatches(await loadBooks(prisma)),
  }).toEqual({
    // the matched crema goes back to stock; the unmatched $16 only takes revenue back
    returns: [
      ['Cambio de producto', '15', '6', 1],
      ['Cambio de producto', '16', '0', 0],
    ],
    original: ['15', '6'],
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
  expect({
    revenue: Number(p5.totalRevenue) - Number(after.totalRevenue),
    cost: Number(p5.totalCost) - Number(after.totalCost),
    returns: await prisma.saleReturn.count({ where: { saleId: p5.id } }),
    unknown: await prisma.saleReturn.count({ where: { clientRequestId: 'square-return-line:rli-4' } }),
  }).toEqual({ revenue: 5, cost: 0, returns: 1, unknown: 0 });
});

test('a Square refund repeating a line already returned, and a line with no uid', async () => {
  const prisma = getPrisma();
  // Both p-1 jarabes are back (one by hand, one in the exchange); p-4's matched crema has 1 left.
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
    crema: Number(p4.totalRevenue) - Number((await prisma.sale.findUniqueOrThrow({ where: { id: p4.id } })).totalRevenue),
  }).toEqual({ jarabe: 0, noUid: 0, crema: 15 });
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
