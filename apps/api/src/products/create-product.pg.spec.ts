/**
 * Creating a product against a real Postgres engine (see testing/pglite.ts)
 * and a recorded Square client: nothing is left behind in either when it fails.
 */
import { assert } from 'riteway/vitest';
import { randomUUID } from 'crypto';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService, type CreateProductInput } from './products.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let norte: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  ({ id: norte } = await prisma.location.create({ data: { squareId: 'SQ-NORTE', name: 'Norte' } }));
  await prisma.cutoverLock.create({ data: { locationId: centro, cutoverDate: new Date('2026-09-01') } });
}, 120_000);

afterAll(() => stop?.());

/** The service over a recorded Square client; `itemIds` lists the Square items it created. */
function productsWithSquare() {
  const products = new ProductsService(prisma);
  const itemIds: string[] = [];
  const square = {
    itemIds,
    catalog: {
      object: {
        upsert: vi.fn(async () => {
          const id = randomUUID();
          itemIds.push(`ITEM-${id}`);
          return { catalogObject: { type: 'ITEM', id: `ITEM-${id}`, itemData: { variations: [{ id: `VAR-${id}` }] } } };
        }),
      },
      batchDelete: vi.fn().mockResolvedValue({}),
    },
    inventory: { batchCreateChanges: vi.fn().mockResolvedValue({}) },
  };
  products['squareClient'] = square as any;
  return { products, square };
}

const create = (products: ProductsService, input: Partial<CreateProductInput>) =>
  products.createProduct({ name: `Producto-${Math.random()}`, sellingPrice: 30, locationId: centro, ...input } as CreateProductInput);

const statusOf = (p: Promise<unknown>) => p.then(() => 201, (e: any) => e.status);

const productsNamed = (name: string) => prisma.product.count({ where: { name } });

describe('ProductsService.createProduct (Postgres)', () => {
  test('initial stock at a location before its cutover', async () => {
    const { products, square } = productsWithSquare();
    const name = `Antes-${Math.random()}`;
    const status = await statusOf(create(products, { name, locationId: norte, initialStock: 5, costPrice: 10 }));

    assert({
      given: 'initial stock at a location that has not finished its cutover',
      should: 'refuse with a 400 before creating anything in Square or the database',
      actual: [status, square.catalog.object.upsert.mock.calls.length, await productsNamed(name)],
      expected: [400, 0, 0],
    });
  });

  test('numbers that are not valid', async () => {
    const { products, square } = productsWithSquare();
    const name = `Malo-${Math.random()}`;
    const statuses = [];
    for (const input of [
      { costPrice: 'abc' },
      { costPrice: -1 },
      { initialStock: 1.5, costPrice: 10 },
      { initialStock: '5', costPrice: 10 },
      { quantity: 2.5 },
      { initialStock: 5 },
    ] as any[]) {
      statuses.push(await statusOf(create(products, { name, ...input })));
    }

    assert({
      given: 'a text or negative cost, fractional or text stock, a fractional box quantity, and stock with no cost',
      should: 'refuse each with a 400 before creating anything',
      actual: [statuses, square.catalog.object.upsert.mock.calls.length, await productsNamed(name)],
      expected: [[400, 400, 400, 400, 400, 400], 0, 0],
    });
  });

  test('a SKU with spaces around it', async () => {
    const { products, square } = productsWithSquare();
    const sku = `SKU-${Math.random()}`;
    await prisma.product.create({ data: { name: 'Existente', sku } });
    const duplicate = await statusOf(create(products, { sku: ` ${sku} ` }));
    const fresh = `NEW-${Math.random()}`;
    const { product } = await create(products, { sku: ` ${fresh} ` });

    assert({
      given: 'a SKU that matches an existing one once trimmed, then a new SKU with spaces',
      should: 'refuse the duplicate, and send Square and store the trimmed new SKU',
      actual: [duplicate, square.catalog.object.upsert.mock.calls.map(([r]: any) => r.object.itemData.variations[0].itemVariationData.sku), product?.sku],
      expected: [400, [fresh], fresh],
    });
  });

  test('the database failing after the Square item was created', async () => {
    const { products, square } = productsWithSquare();
    const name = `Falla-${Math.random()}`;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_mapping() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'mapping insert failed'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_mapping BEFORE INSERT ON "CatalogMapping" FOR EACH ROW EXECUTE FUNCTION fail_mapping()`);

    const failed = await create(products, { name }).then(() => false, () => true);
    await prisma.$executeRawUnsafe(`DROP TRIGGER fail_mapping ON "CatalogMapping"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION fail_mapping()`);

    assert({
      given: 'the catalog mapping insert failing after Square created the item',
      should: 'fail, leave no product row, and delete the Square item',
      actual: [failed, await productsNamed(name), square.catalog.batchDelete.mock.calls],
      expected: [true, 0, [[{ objectIds: square.itemIds }]]],
    });
  });

  test('a retried create', async () => {
    const { products, square } = productsWithSquare();
    const clientRequestId = randomUUID();
    const name = `Reintento-${Math.random()}`;
    const first = await create(products, { name, clientRequestId, initialStock: 3, costPrice: 10 });
    const second = await create(products, { name, clientRequestId, initialStock: 3, costPrice: 10 });

    assert({
      given: 'the same create sent twice with one clientRequestId',
      should: 'create one product, one Square item and one stock batch, and answer the retry with the same product',
      actual: [
        await productsNamed(name),
        square.catalog.object.upsert.mock.calls.length,
        await prisma.inventory.count({ where: { productId: first.product!.id } }),
        second.product?.id,
      ],
      expected: [1, 1, 1, first.product?.id],
    });
  });

  test('a name with spaces around it', async () => {
    const { products } = productsWithSquare();
    const result = await create(products, { name: '  Gel  ' });

    assert({
      given: 'a name with spaces around it',
      should: 'report the name the product was saved under',
      actual: result.message,
      expected: 'Product "Gel" created and synced to Square',
    });
  });
});
