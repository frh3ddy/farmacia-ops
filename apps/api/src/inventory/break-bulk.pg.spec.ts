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
let oriente: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  await prisma.cutoverLock.create({ data: { locationId: centro, cutoverDate: new Date('2026-09-01') } });
  ({ id: oriente } = await prisma.location.create({ data: { squareId: 'SQ-ORIENTE', name: 'Oriente' } }));
}, 120_000);

afterAll(() => stop?.());

/** A box product of 10 pieces linked to its loose product, with 5 boxes at Centro. */
async function breakBulkSetup() {
  const adjustments = new InventoryAdjustmentService(prisma);
  const breakBulk = new BreakBulkService(prisma, adjustments);
  const loose = await prisma.product.create({ data: { name: `Loose-${Math.random()}` } });
  const box = await prisma.product.create({ data: { name: `Box-${Math.random()}`, quantity: 10 } });
  await prisma.productLooseLink.create({ data: { locationId: centro, boxProductId: box.id, looseProductId: loose.id } });
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

describe('BreakBulkService per store', () => {
  test("each store's own suelto", async () => {
    const { breakBulk, boxProductId, looseProductId } = await breakBulkSetup();
    const orienteLoose = await prisma.product.create({ data: { name: `Loose-${Math.random()}` } });
    await prisma.productLooseLink.create({ data: { locationId: oriente, boxProductId, looseProductId: orienteLoose.id } });

    await breakBulk.breakBulk({ boxProductId, locationId: centro, boxQuantity: 1 });

    assert({
      given: 'a box opened at a store, while another store pairs it with a different suelto',
      should: "turn it into this store's suelto",
      actual: [await stockOf(looseProductId), await stockOf(orienteLoose.id)],
      expected: [10, 0],
    });
  });

  test('a box linked only at another store', async () => {
    const { breakBulk, boxProductId } = await breakBulkSetup();
    await prisma.productLooseLink.deleteMany({ where: { boxProductId } });
    await prisma.productLooseLink.create({ data: { locationId: oriente, boxProductId, looseProductId: (await prisma.product.create({ data: { name: 'x' } })).id } });

    await prisma.product.update({ where: { id: boxProductId }, data: { name: 'Paracetamol Caja' } });
    const error = await breakBulk.breakBulk({ boxProductId, locationId: centro, boxQuantity: 1 }).catch((e) => e);

    assert({
      given: 'a box opened at a store where it has no suelto, though another store has one',
      should: 'refuse with a 400 naming the box and this store, and open nothing',
      actual: [error.status, error.message, await stockOf(boxProductId)],
      expected: [400, 'Paracetamol Caja no tiene suelto vinculado en Centro. Vincúlalo primero.', 5],
    });
  });
});

describe('BreakBulkService lots', () => {
  test('boxes with caducidad broken into loose units', async () => {
    const { breakBulk, boxProductId, looseProductId } = await breakBulkSetup();
    // Replace the setup's 5 boxes with two lots: 1 box expiring sooner, received later.
    await prisma.inventory.deleteMany({ where: { productId: boxProductId } });
    await prisma.inventory.createMany({
      data: [
        { productId: boxProductId, locationId: centro, quantity: 1, unitCost: 20, receivedAt: new Date('2026-10-01'), expiryDate: new Date('2027-06-01T18:00:00Z') },
        { productId: boxProductId, locationId: centro, quantity: 1, unitCost: 20, receivedAt: new Date('2026-10-02'), expiryDate: new Date('2027-02-01T18:00:00Z') },
      ],
    });

    await breakBulk.breakBulk({ locationId: centro, boxProductId, boxQuantity: 2 });
    const loose = await prisma.inventory.findFirstOrThrow({ where: { productId: looseProductId } });

    assert({
      given: 'two boxes from lots with different caducidad broken into loose units',
      should: 'give the loose units the soonest caducidad of the boxes taken',
      actual: loose.expiryDate?.toISOString().slice(0, 10),
      expected: '2027-02-01',
    });
  });
});

describe('BreakBulkService.coverLoose', () => {
  /** A loose product with `looseStock` pieces at Centro, and one box product per entry in `boxes`. */
  async function coverSetup({ looseStock = 0, boxes = [{ pieces: 10, stock: 5, expiry: undefined as string | undefined }] } = {}) {
    const breakBulk = new BreakBulkService(prisma, new InventoryAdjustmentService(prisma));
    const loose = await prisma.product.create({ data: { name: `Loose-${Math.random()}` } });
    if (looseStock) {
      await prisma.inventory.create({ data: { productId: loose.id, locationId: centro, quantity: looseStock, unitCost: 1, receivedAt: new Date('2026-10-01') } });
    }
    const boxIds: string[] = [];
    for (const { pieces, stock, expiry } of boxes) {
      const box = await prisma.product.create({ data: { name: `Box-${Math.random()}`, quantity: pieces } });
      await prisma.productLooseLink.create({ data: { locationId: centro, boxProductId: box.id, looseProductId: loose.id } });
      if (stock) {
        await prisma.inventory.create({
          data: { productId: box.id, locationId: centro, quantity: stock, unitCost: 20, receivedAt: new Date('2026-10-01'), expiryDate: expiry ? new Date(expiry) : null },
        });
      }
      boxIds.push(box.id);
    }
    return { breakBulk, looseProductId: loose.id, boxIds };
  }

  const key = () => `sale:${Math.random()}`;

  test('pieces needed with no sueltos in stock', async () => {
    const { breakBulk, looseProductId, boxIds: [boxId] } = await coverSetup();

    const result = await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 3, requestKey: key() });

    assert({
      given: '3 pieces needed, no sueltos and boxes of 10',
      should: 'open one box, leaving 10 sueltos at the box’s cost',
      actual: [result.boxesOpened, await stockOf(boxId), await stockOf(looseProductId), result.costPerLooseUnit],
      expected: [1, 4, 10, 2],
    });
  });

  test('sueltos in stock that cover part of the need', async () => {
    const { breakBulk, looseProductId, boxIds: [boxId] } = await coverSetup({ looseStock: 4 });

    const covered = await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 4, requestKey: key() });
    const partly = await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 13, requestKey: key() });

    assert({
      given: 'sueltos in stock that cover one need fully and another partly',
      should: 'open nothing for the first, and boxes only for the uncovered pieces of the second',
      actual: [covered.boxesOpened, partly.boxesOpened, await stockOf(boxId)],
      expected: [0, 1, 4],
    });
  });

  test('more pieces needed than one box holds', async () => {
    const { breakBulk, looseProductId, boxIds: [boxId] } = await coverSetup({ boxes: [{ pieces: 10, stock: 2, expiry: undefined }] });

    const twoBoxes = await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 11, requestKey: key() });
    const { breakBulk: other, looseProductId: otherLoose } = await coverSetup({ boxes: [{ pieces: 10, stock: 2, expiry: undefined }] });
    const tooMany = await other.coverLoose({ locationId: centro, looseProductId: otherLoose, needed: 50, requestKey: key() });

    assert({
      given: '11 pieces from boxes of 10, and 50 pieces when the store has 2 boxes',
      should: 'open exactly the boxes that cover the need, and no more than the store has',
      actual: [twoBoxes.boxesOpened, await stockOf(boxId), tooMany.boxesOpened, await stockOf(otherLoose)],
      expected: [2, 0, 2, 20],
    });
  });

  test('several box products linked to the suelto', async () => {
    const { breakBulk, looseProductId, boxIds: [later, sooner, none] } = await coverSetup({
      boxes: [
        { pieces: 10, stock: 3, expiry: '2027-06-01T18:00:00Z' },
        { pieces: 30, stock: 3, expiry: '2027-02-01T18:00:00Z' },
        { pieces: 10, stock: 3, expiry: undefined },
      ],
    });

    const result = await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 5, requestKey: key() });

    assert({
      given: 'three linked boxes, one expiring soonest and one with no caducidad',
      should: 'open from the box whose stock expires soonest',
      actual: [result.boxProductId, await stockOf(later), await stockOf(sooner), await stockOf(none)],
      expected: [sooner, 3, 2, 3],
    });
  });

  test('linked boxes with the same caducidad, or none', async () => {
    const { breakBulk, looseProductId, boxIds: [newer, older] } = await coverSetup({
      boxes: [{ pieces: 10, stock: 1, expiry: undefined }, { pieces: 10, stock: 1, expiry: undefined }],
    });
    await prisma.inventory.updateMany({ where: { productId: older }, data: { receivedAt: new Date('2026-09-15') } });

    const result = await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 1, requestKey: key() });

    assert({
      given: 'two linked boxes with no caducidad, one received earlier',
      should: 'open the one received first',
      actual: [result.boxProductId === older, await stockOf(newer)],
      expected: [true, 1],
    });
  });

  test('the request key on the opening', async () => {
    const { breakBulk, looseProductId } = await coverSetup();
    const requestKey = key();

    await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 1, requestKey });
    const keys = await prisma.inventoryAdjustment.findMany({
      where: { clientRequestId: { startsWith: `auto-open:${requestKey}` } },
      select: { type: true },
    });

    assert({
      given: 'a cover with a request key',
      should: 'store the key on both legs under the auto-open prefix',
      actual: keys.map((k) => k.type).sort(),
      expected: ['BREAK_BULK_IN', 'BREAK_BULK_OUT'],
    });
  });

  test('no linked box with stock', async () => {
    const { breakBulk, looseProductId } = await coverSetup({ boxes: [{ pieces: 10, stock: 0, expiry: undefined }] });

    const result = await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 3, requestKey: key() });

    assert({
      given: 'a suelto whose only linked box has no stock at the store',
      should: 'open nothing and say so',
      actual: [result.boxesOpened, await stockOf(looseProductId)],
      expected: [0, 0],
    });
  });

  test('a box linked to the suelto only at another store', async () => {
    const { breakBulk, looseProductId, boxIds: [boxId] } = await coverSetup();
    await prisma.productLooseLink.updateMany({ where: { boxProductId: boxId }, data: { locationId: oriente } });

    const result = await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 3, requestKey: key() });

    assert({
      given: "a sale short on a suelto whose box in stock here is paired with it only at another store",
      should: "open nothing, since this store's box turns into a different suelto or none",
      actual: [result.boxesOpened, await stockOf(boxId)],
      expected: [0, 5],
    });
  });

  test('the same request sent twice', async () => {
    const { breakBulk, looseProductId, boxIds: [boxId] } = await coverSetup();
    const requestKey = key();

    const first = await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 3, requestKey });
    // A replay that, read fresh, would need two more boxes: it must still be the first opening.
    const replay = await breakBulk.coverLoose({ locationId: centro, looseProductId, needed: 25, requestKey });

    assert({
      given: 'a cover replayed with the same request key',
      should: 'return the first opening and open nothing more',
      actual: [replay.boxesOpened, replay.boxProductId, await stockOf(boxId), await prisma.inventoryAdjustment.count({ where: { productId: boxId } })],
      expected: [first.boxesOpened, first.boxProductId, 4, 1],
    });
  });
});

describe('BreakBulkService.automaticOpenings', () => {
  test('boxes opened by sales and shortfalls covered without a box', async () => {
    const { id: store } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Norte' } });
    await prisma.cutoverLock.create({ data: { locationId: store, cutoverDate: new Date('2026-09-01') } });
    const breakBulk = new BreakBulkService(prisma, new InventoryAdjustmentService(prisma));
    const loose = await prisma.product.create({ data: { name: 'Paracetamol suelto' } });
    const box = await prisma.product.create({ data: { name: 'Paracetamol caja', quantity: 10 } });
    await prisma.productLooseLink.create({ data: { locationId: store, boxProductId: box.id, looseProductId: loose.id } });
    await prisma.inventory.create({ data: { productId: box.id, locationId: store, quantity: 3, unitCost: 20, receivedAt: new Date('2026-10-01') } });

    await breakBulk.coverLoose({ locationId: store, looseProductId: loose.id, needed: 3, requestKey: `pay-1:${loose.id}` });
    await breakBulk.breakBulk({ boxProductId: box.id, locationId: store, boxQuantity: 1 }); // by hand: not listed
    // As the worker labels a cover it made because no box could be opened.
    await prisma.inventoryAdjustment.create({
      data: { locationId: store, productId: loose.id, type: 'AUTO_SALE_COVER', quantity: 2, unitCost: 5, totalCost: 10, notes: 'squareId=pay-2 · caja no abierta: api no disponible', adjustedBy: 'SYSTEM', adjustedAt: new Date(Date.now() + 1000) },
    });
    // An unlabeled cover (not a suelto) is not about boxes: not listed.
    await prisma.inventoryAdjustment.create({
      data: { locationId: store, productId: loose.id, type: 'AUTO_SALE_COVER', quantity: 1, unitCost: 5, totalCost: 5, notes: 'squareId=pay-3', adjustedBy: 'SYSTEM' },
    });

    const listed = await breakBulk.automaticOpenings(store);

    assert({
      given: 'a box a sale opened, one opened by hand, a labeled cover and an unlabeled one',
      should: 'list the sale’s opening and the labeled cover, newest first, each with its sale',
      actual: listed.map(({ kind, productName, quantity, paymentId, why }) => ({ kind, productName, quantity, paymentId, why })),
      expected: [
        { kind: 'covered', productName: 'Paracetamol suelto', quantity: 2, paymentId: 'pay-2', why: 'api no disponible' },
        { kind: 'opened', productName: 'Paracetamol caja', quantity: 1, paymentId: 'pay-1', why: undefined },
      ],
    });
  });
});
