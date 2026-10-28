/**
 * InventoryAdjustmentService against a real Postgres engine (see
 * testing/pglite.ts), so FIFO consumption, the conditional decrement and the
 * non-negative quantity constraint run for real.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let service: InventoryAdjustmentService;
let locationId: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  service = new InventoryAdjustmentService(prisma);
  ({ id: locationId } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  // Finishing a location's cutover writes its lock.
  await prisma.cutoverLock.create({ data: { locationId, cutoverDate: new Date('2026-09-01') } });
}, 120_000);

afterAll(() => stop?.());

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

  test('a request id already used for a different adjustment', async () => {
    const { productId } = await productWithBatches([{ quantity: 10, unitCost: 2, receivedAt: '2026-10-01' }]);
    const { id: elsewhere } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Norte' } });
    const clientRequestId = `req-reused-${productId}`;
    await service.createAdjustment({ locationId, productId, type: 'DAMAGE', quantity: -3, clientRequestId });

    const attempts = [
      { locationId: elsewhere, productId, type: 'DAMAGE' as const, quantity: -3 },
      { locationId, productId, type: 'DAMAGE' as const, quantity: -4 },
      { locationId, productId, type: 'THEFT' as const, quantity: -3 },
    ];
    const outcomes = [];
    for (const attempt of attempts) {
      outcomes.push(await service.createAdjustment({ ...attempt, clientRequestId }).then(
        (r) => `returned ${r.adjustment.id}`,
        (e: Error) => e.message,
      ));
    }

    assert({
      given: 'a request id reused for another location, quantity or type',
      should: "refuse it rather than return the other adjustment or skip this one",
      actual: outcomes,
      expected: Array(3).fill('This clientRequestId was already used for a different adjustment'),
    });
  });

  test('a unit cost sent with a removal', async () => {
    const { productId } = await productWithBatches([{ quantity: 10, unitCost: 3, receivedAt: '2026-10-01' }]);

    const { adjustment } = await service.createAdjustment({ locationId, productId, type: 'DAMAGE', quantity: -2, unitCost: 50 });

    assert({
      given: 'a removal with a client-supplied unit cost',
      should: 'record the FIFO cost, consistent with the total',
      actual: [adjustment.unitCost, adjustment.totalCost],
      expected: ['3', '6'],
    });
  });

  test('a free item added at zero cost', async () => {
    // A costed batch exists, so a lookup would have found $4.
    const { productId } = await productWithBatches([{ quantity: 1, unitCost: 4, receivedAt: '2026-10-01' }]);

    const { adjustment } = await service.createAdjustment({ locationId, productId, type: 'FOUND', quantity: 5, unitCost: 0 });

    assert({
      given: 'stock added at a unit cost of zero',
      should: 'record it at zero rather than looking a cost up',
      actual: adjustment.unitCost,
      expected: '0',
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

describe('InventoryAdjustmentService Square sync (Postgres)', () => {
  /** The service with Square's inventory call recorded; `errors` makes Square reject it. */
  async function syncedProduct(errors?: Array<{ code: string; detail: string }>) {
    const batchCreateChanges = vi.fn().mockResolvedValue(errors ? { errors } : { counts: [] });
    const synced = new InventoryAdjustmentService(prisma);
    synced['squareClient'] = { inventory: { batchCreateChanges } } as any;
    const { productId } = await productWithBatches([{ quantity: 10, unitCost: 2, receivedAt: '2026-10-01' }]);
    await prisma.catalogMapping.create({ data: { productId, squareVariationId: `v-${productId}` } });
    const sentChange = (call = 0) => {
      const request = batchCreateChanges.mock.calls[call][0];
      const { fromState, toState, quantity, locationId: squareLocation } = request.changes[0].adjustment;
      return { idempotencyKey: request.idempotencyKey, fromState, toState, quantity, squareLocation };
    };
    return { synced, productId, batchCreateChanges, sentChange };
  }

  test('a removal', async () => {
    const { synced, productId, sentChange } = await syncedProduct();
    const { adjustment, squareSync } = await synced.createAdjustment({ locationId, productId, type: 'DAMAGE', quantity: -2, syncToSquare: true });

    assert({
      given: 'a damage synced to Square',
      should: 'send it as waste at the location, keyed on the adjustment, and record it as synced',
      actual: [sentChange(), squareSync, (await prisma.inventoryAdjustment.findUniqueOrThrow({ where: { id: adjustment.id } })).squareSynced],
      expected: [
        { idempotencyKey: adjustment.id, fromState: 'IN_STOCK', toState: 'WASTE', quantity: '2', squareLocation: 'SQ-CENTRO' },
        { synced: true },
        true,
      ],
    });
  });

  test('a customer return', async () => {
    const { synced, productId, sentChange } = await syncedProduct();
    await synced.createAdjustment({ locationId, productId, type: 'RETURN', quantity: 1, unitCost: 2, syncToSquare: true });

    assert({
      given: 'a return synced to Square',
      should: 'send it as an unlinked return back into stock',
      actual: [sentChange().fromState, sentChange().toState],
      expected: ['UNLINKED_RETURN', 'IN_STOCK'],
    });
  });

  test('Square rejecting the change, then a retry', async () => {
    const { synced, productId, batchCreateChanges, sentChange } = await syncedProduct([{ code: 'BAD_REQUEST', detail: 'Nope' }]);
    const { adjustment, squareSync } = await synced.createAdjustment({ locationId, productId, type: 'FOUND', quantity: 3, unitCost: 2, syncToSquare: true });
    const stored = await prisma.inventoryAdjustment.findUniqueOrThrow({ where: { id: adjustment.id } });

    batchCreateChanges.mockResolvedValue({ counts: [] });
    const retried = await synced.retrySquareSync(adjustment.id);

    assert({
      given: 'Square rejecting the change',
      should: 'keep the adjustment and record why Square refused it',
      actual: [squareSync, stored.squareSynced, stored.squareSyncError],
      expected: [{ synced: false, error: 'Nope' }, false, 'Nope'],
    });
    assert({
      given: 'a retry that Square accepts',
      should: 'replay the same idempotency key and record it as synced',
      actual: [retried, sentChange(1).idempotencyKey, (await prisma.inventoryAdjustment.findUniqueOrThrow({ where: { id: adjustment.id } })).squareSynced],
      expected: [{ synced: true }, adjustment.id, true],
    });
  });

  test('retrying an adjustment Square already has', async () => {
    const { synced, productId, batchCreateChanges } = await syncedProduct();
    const { adjustment } = await synced.createAdjustment({ locationId, productId, type: 'FOUND', quantity: 3, unitCost: 2, syncToSquare: true });

    assert({
      given: 'a retry of an adjustment already synced',
      should: 'report it synced, with no error and no second call to Square',
      actual: [await synced.retrySquareSync(adjustment.id), batchCreateChanges.mock.calls.length],
      expected: [{ synced: true }, 1],
    });
  });
});

describe('InventoryAdjustmentService.createAdjustment cutover (Postgres)', () => {
  test('a location not cut over yet', async () => {
    const { id: notCutOver } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Oriente' } });
    const { productId } = await productWithBatches([]);

    let error: string | undefined;
    try {
      await service.createAdjustment({ locationId: notCutOver, productId, type: 'FOUND', quantity: 5, unitCost: 1 });
    } catch (e) {
      error = (e as Error).message;
    }

    assert({
      given: 'a location whose cutover has not finished',
      should: 'refuse the adjustment, since the cutover would count that stock again',
      actual: [error, await prisma.inventory.count({ where: { productId } })],
      expected: ['This location has not been cut over yet. Adjustments start once its cutover is complete.', 0],
    });
  });

  test('a cut-over location, dated today', async () => {
    const { productId } = await productWithBatches([]);
    const noonToday = new Date();
    noonToday.setHours(12, 0, 0, 0);

    const result = await service.createAdjustment({
      locationId, productId, type: 'FOUND', quantity: 5, unitCost: 1, effectiveDate: noonToday,
    });

    assert({
      given: 'a date-only "today" (parsed as noon) at a cut-over location',
      should: 'record the adjustment',
      actual: result.inventoryImpact.newTotal,
      expected: 5,
    });
  });

  test('a date on or before the cutover', async () => {
    const { productId } = await productWithBatches([]);

    let error: string | undefined;
    try {
      await service.createAdjustment({
        locationId, productId, type: 'FOUND', quantity: 5, unitCost: 1, effectiveDate: new Date('2026-08-15'),
      });
    } catch (e) {
      error = (e as Error).message;
    }

    assert({
      given: 'an adjustment dated before the location\'s cutover',
      should: 'refuse it',
      actual: error,
      expected: 'Cannot make adjustments before the cutover date. The inventory for this location is locked.',
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
