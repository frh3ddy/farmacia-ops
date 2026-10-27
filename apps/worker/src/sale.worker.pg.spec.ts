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
import { getPrisma, processSaleJob } from './sale.worker';
import { SaleValidationError } from './errors';
import { booksMismatches, loadBooks } from './books-check';

// The worker's moduleResolution can't see package subpath exports; Node's require can.
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');

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

const job = (lineItems: object[], paymentId = 'p-1', squareLocationId = 'SQ-CENTRO') =>
  ({
    id: `evt-${paymentId}`,
    data: {
      payload: {
        object: { payment: { id: paymentId, location_id: squareLocationId, order_id: `o-${paymentId}`, created_at: '2026-10-27T18:00:00Z' } },
        _testOrderData: { id: `o-${paymentId}`, lineItems },
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
