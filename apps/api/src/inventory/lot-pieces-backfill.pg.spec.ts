/**
 * The lot-pieces backfill (prisma/migrations/20261106120000_backfill_lot_pieces) against a
 * real Postgres engine (see testing/pglite.ts): pieces a Conteo inicial split before pieces
 * recorded their source get it, only where the source's split units add up exactly.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

const backfill = () =>
  prisma.$executeRawUnsafe(readFileSync(join(__dirname, '../../../../prisma/migrations/20261106120000_backfill_lot_pieces/migration.sql'), 'utf8'));

/** A store and product counted in a Conteo inicial at `countedAt`. */
async function counted(countedAt = new Date('2026-11-05T21:00:00Z')) {
  const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Lolita' } });
  const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
  const { id: stockCountId } = await prisma.stockCount.create({ data: { locationId } });
  await prisma.stockCountEntry.create({ data: { stockCountId, productId, countedQuantity: 1, previousQuantity: 1, countedAt } });
  return { locationId, productId };
}

/** A batch as the old split left it: no source recorded. */
const batch = (where: { locationId: string; productId: string }, quantity: number, msAfter: number, splitOut = 0) =>
  prisma.inventory.create({
    data: { ...where, quantity, unitCost: 10, receivedAt: new Date(Date.parse('2026-10-01T12:00:00Z') + msAfter), splitOut },
  });

const sourceOf = async (id: string) =>
  (({ splitFromId, splitInitialQuantity }) => [splitFromId, splitInitialQuantity])(await prisma.inventory.findUniqueOrThrow({ where: { id } }));

describe('backfill_lot_pieces migration', () => {
  test('a batch split into a piece, and that piece split again', async () => {
    const where = await counted();
    // Root had 10: split off 6 (piece 1); piece 1 later kept 3 and split off 3 (piece 2), which sold 1.
    const root = await batch(where, 4, 0, 6);
    const piece1 = await batch(where, 3, 1, 3);
    const piece2 = await batch(where, 2, 2);
    await prisma.inventoryConsumption.create({ data: { inventoryId: piece2.id, quantity: 1, unitCost: 10, totalCost: 10 } });

    await backfill();

    assert({
      given: 'pieces of a batch and of a piece, whose units add up to what each split off',
      should: 'point both at the root batch with the units each started with',
      actual: [await sourceOf(piece1.id), await sourceOf(piece2.id), await sourceOf(root.id)],
      expected: [[root.id, 6], [root.id, 3], [null, null]],
    });
    const logs = await prisma.auditLog.findMany({ where: { action: 'BACKFILL_LOT_PIECE', entityId: { in: [piece1.id, piece2.id] } } });
    assert({
      given: 'the same backfill',
      should: 'log each linked piece with its source and starting units, at its store',
      actual: logs
        .map((l) => [l.entityType, l.entityId, l.locationId, l.details])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      expected: [
        ['Inventory', piece1.id, where.locationId, { splitFromId: root.id, splitInitialQuantity: 6 }],
        ['Inventory', piece2.id, where.locationId, { splitFromId: root.id, splitInitialQuantity: 3 }],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    });
  });

  test('a piece two batches could have split', async () => {
    const where = await counted();
    await batch(where, 1, 0, 2);
    await batch(where, 1, 0, 2);
    const piece = await batch(where, 2, 1);

    await backfill();

    assert({
      given: 'a piece right after two batches received at the same moment',
      should: 'leave it without a source',
      actual: await sourceOf(piece.id),
      expected: [null, null],
    });
  });

  test("a batch that isn't one of the split's pieces", async () => {
    const where = await counted();
    await batch(where, 1, 0, 4);
    const piece = await batch(where, 4, 1);
    const loadedLater = await batch(where, 7, 5);

    await backfill();

    assert({
      given: "a split's piece next to another batch in the same second, so the units don't add up",
      should: 'leave both without a source',
      actual: [await sourceOf(piece.id), await sourceOf(loadedLater.id)],
      expected: [
        [null, null],
        [null, null],
      ],
    });
  });

  test('a product not counted since lots went live', async () => {
    const where = await counted(new Date('2026-11-05T12:00:00Z'));
    await batch(where, 1, 0, 2);
    const piece = await batch(where, 2, 1);

    await backfill();

    assert({
      given: 'a split that adds up, on a product last counted before lots went live',
      should: 'leave it alone',
      actual: await sourceOf(piece.id),
      expected: [null, null],
    });
  });
});
