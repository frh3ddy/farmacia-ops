/**
 * InventoryAdjustmentService against a real Postgres engine (PGlite with every
 * migration), so FIFO consumption, the conditional decrement and the
 * non-negative quantity constraint run for real. PrismaService reaches PGlite
 * through pglite-socket.
 *
 * PGlite is a single connection, so two transactions can't interleave here:
 * the race itself is covered by inventory-adjustment.spec.ts; this proves the
 * guards the fix relies on.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PGlite, type Extension } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { assert } from 'riteway/vitest';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';

// The migrations need pg_trgm. tsconfig's module resolution can't see package
// `exports` subpaths (see product-search.pg.spec.ts), so require it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm') as { pg_trgm: Extension };

const MIGRATIONS = join(__dirname, '../../../../prisma/migrations');
let db: PGlite;
let server: PGLiteSocketServer;
let prisma: PrismaService;
let service: InventoryAdjustmentService;
let locationId: string;

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pg_trgm } });
  for (const dir of readdirSync(MIGRATIONS).filter((d) => !d.endsWith('.toml')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  }
  const port = 55_000 + Math.floor(Math.random() * 1_000);
  server = new PGLiteSocketServer({ db, port });
  await server.start();
  // PGlite is a single connection.
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  process.env.DATABASE_POOL_MAX = '1';
  prisma = new PrismaService();
  service = new InventoryAdjustmentService(prisma);
  ({ id: locationId } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
}, 120_000);

afterAll(async () => {
  await prisma?.onModuleDestroy();
  await server?.stop();
  await db?.close();
});

/** A fresh product with the given batches, created in the order listed. */
async function productWithBatches(batches: Array<{ quantity: number; unitCost: number; receivedAt: string }>) {
  const product = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
  const created = [];
  for (const b of batches) {
    created.push(await prisma.inventory.create({
      data: { productId: product.id, locationId, quantity: b.quantity, unitCost: b.unitCost, receivedAt: new Date(b.receivedAt) },
    }));
  }
  return { productId: product.id, batches: created };
}

describe('InventoryAdjustmentService.createAdjustment (Postgres)', () => {
  test('a removal spanning two batches', async () => {
    // Inserted newest-first, so creation order disagrees with receiving order.
    const { productId, batches: [newer, older] } = await productWithBatches([
      { quantity: 10, unitCost: 5, receivedAt: '2026-10-20' },
      { quantity: 4, unitCost: 2, receivedAt: '2026-10-01' },
    ]);

    const result = await service.createAdjustment({ locationId, productId, type: 'DAMAGE', quantity: -6 });
    const remaining = await prisma.inventory.findMany({ where: { productId }, orderBy: { receivedAt: 'asc' } });
    const consumed = await prisma.inventoryConsumption.findMany({ where: { adjustmentId: result.adjustment.id } });

    assert({
      given: 'a removal larger than the oldest-received batch',
      should: 'empty that batch first, then take the rest from the next',
      actual: remaining.map((b) => [b.id, b.quantity]),
      expected: [[older.id, 0], [newer.id, 8]],
    });
    assert({
      given: 'the removal',
      should: 'record each batch taken from at its own cost, totalling the FIFO cost',
      actual: [
        consumed.map((c) => [c.inventoryId, c.quantity, c.unitCost.toString()]).sort(),
        result.adjustment.totalCost,
      ],
      expected: [[[newer.id, 2, '5'], [older.id, 4, '2']].sort(), '18'],
    });
  });

  test('stock taken between reading the batches and decrementing them', async () => {
    const { productId, batches: [batch] } = await productWithBatches([
      { quantity: 5, unitCost: 2, receivedAt: '2026-10-01' },
    ]);
    // Stands in for a concurrent sale: the service inserts the adjustment row
    // after reading the batches and before decrementing them, so this empties
    // the batch at exactly that point, inside the same transaction.
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION take_stock() RETURNS trigger AS $$
      BEGIN
        UPDATE "Inventory" SET quantity = 0 WHERE id = '${batch.id}';
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER take_stock AFTER INSERT ON "InventoryAdjustment"
      FOR EACH ROW WHEN (NEW."productId" = '${productId}') EXECUTE FUNCTION take_stock();
    `);

    let error: string | undefined;
    try {
      await service.createAdjustment({ locationId, productId, type: 'DAMAGE', quantity: -3 });
    } catch (e) {
      error = (e as Error).message;
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER take_stock ON "InventoryAdjustment"; DROP FUNCTION take_stock();');
    }

    assert({
      given: 'a batch emptied after it was read',
      should: 'refuse the removal as a retryable conflict',
      actual: error,
      expected: 'Stock changed while recording this adjustment — please retry',
    });
    assert({
      given: 'the refused removal',
      should: 'roll everything back, leaving the batch and no adjustment',
      actual: [
        (await prisma.inventory.findUniqueOrThrow({ where: { id: batch.id } })).quantity,
        await prisma.inventoryAdjustment.count({ where: { productId } }),
      ],
      expected: [5, 0],
    });
  });

  test('the same offline request sent twice', async () => {
    const { productId } = await productWithBatches([{ quantity: 10, unitCost: 2, receivedAt: '2026-10-01' }]);
    const request = { locationId, productId, type: 'DAMAGE' as const, quantity: -3, clientRequestId: `req-${productId}` };

    const first = await service.createAdjustment(request);
    const replay = await service.createAdjustment(request);

    assert({
      given: 'a replay of a request that already committed',
      should: 'return the same adjustment and take the stock once',
      actual: [
        replay.adjustment.id,
        (await prisma.inventory.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity,
      ],
      expected: [first.adjustment.id, 7],
    });
  });

  test('stock added', async () => {
    const { productId } = await productWithBatches([]);

    const result = await service.createAdjustment({ locationId, productId, type: 'FOUND', quantity: 4, unitCost: 3 });
    const batch = await prisma.inventory.findUniqueOrThrow({
      where: { id: result.inventoryImpact.batchCreated! },
      include: { createdByAdjustment: true },
    });

    assert({
      given: 'an addition',
      should: 'create one batch of that quantity and cost, linked back to the adjustment',
      actual: [batch.quantity, batch.unitCost.toString(), batch.createdByAdjustment?.id],
      expected: [4, '3', result.adjustment.id],
    });
  });
});

describe('Inventory quantity constraint (Postgres)', () => {
  test('any writer driving a batch below zero', async () => {
    const { batches: [batch] } = await productWithBatches([{ quantity: 2, unitCost: 1, receivedAt: '2026-10-01' }]);

    let error: string | undefined;
    try {
      await prisma.inventory.update({ where: { id: batch.id }, data: { quantity: { decrement: 3 } } });
    } catch (e) {
      error = (e as Error).message;
    }

    assert({
      given: 'a write that would leave a batch negative, from outside the adjustment service',
      should: 'be refused by the database',
      actual: error?.includes('Inventory_quantity_nonnegative'),
      expected: true,
    });
  });
});
