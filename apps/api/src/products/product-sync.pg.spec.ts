/**
 * The phone's product sync: only what changed since its cursor, in the
 * product list's row shape, with removals, against a real Postgres engine.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let products: ProductsService;
let centro: string;
let oriente: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  products = new ProductsService(prisma);
  ({ id: centro } = await prisma.location.create({ data: { name: 'Centro', squareId: 'SQ-CENTRO' } }));
  ({ id: oriente } = await prisma.location.create({ data: { name: 'Oriente', squareId: 'SQ-ORIENTE' } }));
}, 120_000);

afterAll(() => stop?.());

const product = async (name: string, stock = 0) => {
  const p = await prisma.product.create({ data: { name } });
  if (stock) await prisma.inventory.create({ data: { productId: p.id, locationId: centro, quantity: stock, receivedAt: new Date(), unitCost: 2 } });
  return p;
};

/** Every page of one walk from `cursor`, merged, and the cursor it ends on. */
async function walk(cursor?: string, limit?: number) {
  const seen = { ids: [] as string[], removedIds: [] as string[], pages: 0, rows: [] as any[] };
  for (;;) {
    const page = await products.syncProducts(centro, cursor, limit);
    seen.pages++;
    seen.rows.push(...page.data);
    seen.ids.push(...page.data.map((p: { id: string }) => p.id));
    seen.removedIds.push(...page.removedIds);
    cursor = page.cursor;
    if (!page.hasMore) return { ...seen, cursor };
  }
}

describe('ProductsService.syncProducts', () => {
  test('a sale after the phone caught up', async () => {
    const [sold] = [await product('Jarabe', 5), await product('Suero', 3)];
    const { cursor } = await walk();
    const batch = await prisma.inventory.findFirstOrThrow({ where: { productId: sold.id } });

    await prisma.$executeRaw`UPDATE "Inventory" SET quantity = quantity - 2 WHERE id = ${batch.id}`;
    const next = await walk(cursor);

    assert({
      given: 'a sale taking stock off one product since the last sync',
      should: 'send only that product, with its new stock, in the list row shape',
      actual: next.rows.map((p) => ({ id: p.id, totalInventory: p.totalInventory, averageCost: p.averageCost })),
      expected: [{ id: sold.id, totalInventory: 3, averageCost: 2 }],
    });
  });

  test('nothing changed', async () => {
    await product('Gasas');
    const { cursor } = await walk();

    const next = await walk(cursor);

    assert({
      given: 'a sync with nothing changed since the last one',
      should: 'send no products and no removals',
      actual: [next.ids, next.removedIds],
      expected: [[], []],
    });
  });

  test('a product deleted, and a product now sold only at another store', async () => {
    const [deleted, moved] = [await product('Venda'), await product('Alcohol')];
    const { cursor } = await walk();

    await prisma.product.delete({ where: { id: deleted.id } });
    await prisma.product.update({ where: { id: moved.id }, data: { soldOnlyAtLocationId: oriente } });
    const next = await walk(cursor);

    assert({
      given: "a product deleted and one moved to another store's own list",
      should: 'report both as removed for this store, and send neither as a product',
      actual: [next.ids, [...next.removedIds].sort()],
      expected: [[], [deleted.id, moved.id].sort()],
    });
  });

  test('one transaction stamping more products than a page', async () => {
    const { cursor } = await walk();
    const names = ['A', 'B', 'C', 'D', 'E'].map((n) => `Lote-${n}-${Math.random()}`);

    await prisma.product.createMany({ data: names.map((name) => ({ name })) });
    const next = await walk(cursor, 2);
    const created = await prisma.product.findMany({ where: { name: { in: names } }, select: { id: true } });

    assert({
      given: 'five products stamped by one transaction and pages of two',
      should: 'page through all five, each once',
      actual: [next.pages, [...next.ids].sort()],
      expected: [3, created.map((p) => p.id).sort()],
    });
  });

  test('a full walk from no cursor', async () => {
    const all = await prisma.product.findMany({ where: { OR: [{ soldOnlyAtLocationId: null }, { soldOnlyAtLocationId: centro }] }, select: { id: true } });

    const full = await walk(undefined, 3);

    assert({
      given: 'no cursor',
      should: 'send every product this store sells',
      actual: [...full.ids].sort(),
      expected: all.map((p) => p.id).sort(),
    });
  });

  test('a cursor that is not one', async () => {
    const error = await products.syncProducts(centro, 'nope').then(() => null, (e: Error) => e.message);

    assert({
      given: 'a malformed cursor',
      should: 'refuse it in Spanish',
      actual: error,
      expected: 'Cursor de sincronización inválido',
    });
  });
});
