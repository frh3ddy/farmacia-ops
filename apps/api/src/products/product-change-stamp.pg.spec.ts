/**
 * The database stamps each product with the id of the transaction that last
 * changed what the product list shows of it, whoever writes (Prisma or raw SQL).
 */
import { assert } from 'riteway/vitest';
import { Prisma } from '@prisma/client';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let locationId: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: locationId } = await prisma.location.create({ data: { name: 'Centro', squareId: 'SQ-CENTRO' } }));
}, 120_000);

afterAll(() => stop?.());

const product = (data: Partial<Prisma.ProductUncheckedCreateInput> = {}) =>
  prisma.product.create({ data: { name: `P-${Math.random()}`, ...data } });

const batch = (productId: string) =>
  prisma.inventory.create({ data: { productId, locationId, quantity: 5, receivedAt: new Date(), unitCost: 2 } });

const stampOf = async (id: string) =>
  (await prisma.$queryRaw<{ x: bigint }[]>`SELECT "changeXid"::text::bigint AS x FROM "Product" WHERE id = ${id}`)[0]?.x;

/** Runs `write` in one transaction and returns that transaction's id. */
const inTransaction = (write: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
  prisma.$transaction(async (tx) => {
    await write(tx);
    return (await tx.$queryRaw<{ x: bigint }[]>`SELECT pg_current_xact_id()::text::bigint AS x`)[0].x;
  });

describe('product change stamp', () => {
  test('a sale taking stock off a batch with raw SQL', async () => {
    const p = await product();
    const b = await batch(p.id);

    const xid = await inTransaction((tx) => tx.$executeRaw`UPDATE "Inventory" SET quantity = quantity - 1 WHERE id = ${b.id}`);

    assert({
      given: "a raw UPDATE of a product's batch",
      should: "stamp the product with the writing transaction's id",
      actual: await stampOf(p.id),
      expected: xid,
    });
  });

  test('a batch deleted, and a batch added', async () => {
    const [deleted, added] = [await product(), await product()];
    const b = await batch(deleted.id);

    const deleteXid = await inTransaction((tx) => tx.inventory.delete({ where: { id: b.id } }));
    const addXid = await inTransaction((tx) => tx.inventory.create({ data: { productId: added.id, locationId, quantity: 1, receivedAt: new Date(), unitCost: 1 } }));

    assert({
      given: 'a batch deleted from one product and added to another',
      should: 'stamp each product with its transaction',
      actual: [await stampOf(deleted.id), await stampOf(added.id)],
      expected: [deleteXid, addXid],
    });
  });

  test('a price link moved from one product to another', async () => {
    const [from, to] = [await product(), await product()];
    const link = await prisma.catalogMapping.create({ data: { productId: from.id, squareVariationId: `v-${from.id}`, priceCents: 1000 } });

    const xid = await inTransaction((tx) => tx.catalogMapping.update({ where: { id: link.id }, data: { productId: to.id } }));

    assert({
      given: 'a price link moved between products',
      should: 'stamp both products',
      actual: [await stampOf(from.id), await stampOf(to.id)],
      expected: [xid, xid],
    });
  });

  test("a raw price refresh, and a price link's deletion", async () => {
    const [refreshed, unlinked] = [await product(), await product()];
    await prisma.catalogMapping.create({ data: { productId: refreshed.id, squareVariationId: `v-${refreshed.id}`, priceCents: 1000 } });
    const link = await prisma.catalogMapping.create({ data: { productId: unlinked.id, squareVariationId: `v-${unlinked.id}` } });

    const refreshXid = await inTransaction(
      (tx) => tx.$executeRaw`UPDATE "CatalogMapping" SET "priceCents" = 1200 WHERE "squareVariationId" = ${`v-${refreshed.id}`}`,
    );
    const unlinkXid = await inTransaction((tx) => tx.catalogMapping.delete({ where: { id: link.id } }));

    assert({
      given: 'a raw price UPDATE on one product and a price link deleted from another',
      should: 'stamp each product with its transaction',
      actual: [await stampOf(refreshed.id), await stampOf(unlinked.id)],
      expected: [refreshXid, unlinkXid],
    });
  });

  test('a category and a store renamed', async () => {
    const category = await prisma.category.create({ data: { name: 'Jarabes' } });
    const store = await prisma.location.create({ data: { name: 'Oriente', squareId: `SQ-${Math.random()}` } });
    const [inCategory, linkedThere, elsewhere] = [await product({ categoryId: category.id }), await product(), await product()];
    await prisma.catalogMapping.create({ data: { productId: linkedThere.id, locationId: store.id, squareVariationId: `v-${linkedThere.id}` } });
    const before = await stampOf(elsewhere.id);

    const categoryXid = await inTransaction((tx) => tx.category.update({ where: { id: category.id }, data: { name: 'Jarabes y suspensiones' } }));
    const storeXid = await inTransaction((tx) => tx.location.update({ where: { id: store.id }, data: { name: 'Oriente Norte' } }));

    assert({
      given: 'a category renamed and a store renamed',
      should: 'stamp the products in that category and the ones linked at that store, and no other',
      actual: [await stampOf(inCategory.id), await stampOf(linkedThere.id), await stampOf(elsewhere.id)],
      expected: [categoryXid, storeXid, before],
    });
  });

  test('a store and a category saved with nothing changed', async () => {
    const category = await prisma.category.create({ data: { name: 'Curación' } });
    const store = await prisma.location.create({ data: { name: 'Poniente', squareId: `SQ-${Math.random()}` } });
    const p = await product({ categoryId: category.id });
    await prisma.catalogMapping.create({ data: { productId: p.id, locationId: store.id, squareVariationId: `v-${p.id}` } });
    const before = await stampOf(p.id);

    // The store sync from Square rewrites every store's name, address and status each run.
    await prisma.location.update({ where: { id: store.id }, data: { name: 'Poniente', isActive: true } });
    await prisma.category.update({ where: { id: category.id }, data: { name: 'Curación' } });

    assert({
      given: 'a store and a category re-saved with the same values',
      should: 'leave their products stamped as they were, so the phone is not sent the whole catalog',
      actual: await stampOf(p.id),
      expected: before,
    });
  });

  test('a product edited, and a product deleted', async () => {
    const [edited, deleted] = [await product(), await product()];

    const editXid = await inTransaction((tx) => tx.product.update({ where: { id: edited.id }, data: { name: 'Paracetamol 500' } }));
    const deleteXid = await inTransaction((tx) => tx.product.delete({ where: { id: deleted.id } }));

    assert({
      given: 'a product edited',
      should: 'stamp it',
      actual: await stampOf(edited.id),
      expected: editXid,
    });
    assert({
      given: 'a product deleted',
      should: "keep a removal mark with the deleting transaction's id",
      actual: await prisma.$queryRaw<{ x: bigint }[]>`SELECT "changeXid"::text::bigint AS x FROM "ProductRemoval" WHERE "productId" = ${deleted.id}`,
      expected: [{ x: deleteXid }],
    });
  });
});
