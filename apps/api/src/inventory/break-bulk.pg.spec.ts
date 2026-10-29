/**
 * Break-bulk against a real Postgres engine (see testing/pglite.ts): boxes of
 * one product become loose units of its linked product at a cut-over location.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { BreakBulkService } from './break-bulk.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  await prisma.cutoverLock.create({ data: { locationId: centro, cutoverDate: new Date('2026-09-01') } });
}, 120_000);

afterAll(() => stop?.());

/** A box product of 10 pieces linked to its loose product, with 5 boxes at Centro. */
async function breakBulkSetup() {
  const adjustments = new InventoryAdjustmentService(prisma);
  const breakBulk = new BreakBulkService(prisma, adjustments);
  const loose = await prisma.product.create({ data: { name: `Loose-${Math.random()}` } });
  const box = await prisma.product.create({ data: { name: `Box-${Math.random()}`, quantity: 10, looseProductId: loose.id } });
  await prisma.inventory.create({ data: { productId: box.id, locationId: centro, quantity: 5, unitCost: 20, receivedAt: new Date('2026-10-01') } });
  return { adjustments, breakBulk, boxProductId: box.id, looseProductId: loose.id };
}

const stockOf = async (productId: string) =>
  (await prisma.inventory.aggregate({ where: { productId }, _sum: { quantity: true } }))._sum.quantity ?? 0;

describe('BreakBulkService (Postgres)', () => {
  test('a box quantity that is not a whole number', async () => {
    const { breakBulk, boxProductId, looseProductId } = await breakBulkSetup();

    const outcomes = [];
    for (const boxQuantity of ['2', 1.5, true] as any[]) {
      outcomes.push(await breakBulk.breakBulk({ boxProductId, locationId: centro, boxQuantity }).then(
        () => 'broken',
        (e: any) => e.status,
      ));
    }

    assert({
      given: 'a box quantity sent as a string, a fraction or a boolean',
      should: 'refuse each with a 400 and open no boxes',
      actual: [outcomes, await stockOf(boxProductId), await stockOf(looseProductId)],
      expected: [[400, 400, 400], 5, 0],
    });
  });

  test('the loose leg failing after the boxes were taken', async () => {
    const { breakBulk, boxProductId, looseProductId } = await breakBulkSetup();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'batch insert failed'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_batch BEFORE INSERT ON "Inventory" FOR EACH ROW EXECUTE FUNCTION fail_insert()`);

    const error = await breakBulk.breakBulk({ boxProductId, locationId: centro, boxQuantity: 2 })
      .then(() => undefined, (e: Error) => e.message);
    await prisma.$executeRawUnsafe(`DROP TRIGGER fail_batch ON "Inventory"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION fail_insert()`);

    assert({
      given: 'the loose batch failing to insert after the boxes were consumed',
      should: 'roll the box leg back, leaving the boxes and no adjustments',
      actual: [
        error?.includes('batch insert failed'),
        await stockOf(boxProductId),
        await stockOf(looseProductId),
        await prisma.inventoryAdjustment.count({ where: { productId: { in: [boxProductId, looseProductId] } } }),
      ],
      expected: [true, 5, 0, 0],
    });
  });

  test('syncing to Square', async () => {
    const { adjustments, breakBulk, boxProductId, looseProductId } = await breakBulkSetup();
    const batchCreateChanges = vi.fn().mockResolvedValue({ counts: [] });
    adjustments['squareClient'] = { inventory: { batchCreateChanges } } as any;
    for (const productId of [boxProductId, looseProductId]) {
      await prisma.catalogMapping.create({ data: { productId, squareVariationId: `v-${productId}` } });
    }

    const result = await breakBulk.breakBulk({ boxProductId, locationId: centro, boxQuantity: 2, syncToSquare: true });
    const saved = await prisma.inventoryAdjustment.findMany({
      where: { productId: { in: [boxProductId, looseProductId] } },
      orderBy: { quantity: 'asc' },
    });

    assert({
      given: '2 boxes broken with Square sync on',
      should: 'tell Square about both legs after the commit and record each result on its adjustment',
      actual: [
        batchCreateChanges.mock.calls.map(([r]) => r.changes.map(({ adjustment: a }: any) => [a.fromState, a.toState, a.quantity])),
        saved.map((a) => [a.type, a.squareSynced]),
        [result.boxAdjustment.squareSync, result.looseAdjustment.squareSync],
      ],
      expected: [
        [[['IN_STOCK', 'NONE', '2']], [['NONE', 'IN_STOCK', '20']]],
        [['BREAK_BULK_OUT', true], ['BREAK_BULK_IN', true]],
        [{ synced: true }, { synced: true }],
      ],
    });
  });
});
