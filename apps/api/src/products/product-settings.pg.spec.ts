/**
 * Product settings (loose link, search aliases, Yastás mapping, category
 * keywords) against a real Postgres engine (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let products: ProductsService;
let centro: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  products = new ProductsService(prisma);
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
}, 120_000);

afterAll(() => stop?.());

const newProduct = async (data: object = {}) =>
  (await prisma.product.create({ data: { name: `Producto-${Math.random()}`, ...data } })).id;

const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: any) => e.status);

describe('ProductsService.setLooseProductLink (Postgres)', () => {
  test('a box quantity that is not a whole number', async () => {
    const loose = await newProduct();
    const box = await newProduct();
    const statuses = [];
    for (const quantity of [1.5, '10', 0] as any[]) {
      statuses.push(await statusOf(products.setLooseProductLink(box, loose, quantity)));
    }

    assert({
      given: 'a box quantity that is a fraction, text or zero',
      should: 'refuse each with a 400 and leave the box unlinked',
      actual: [statuses, (await prisma.product.findUnique({ where: { id: box } }))?.looseProductId],
      expected: [[400, 400, 400], null],
    });
  });

  test('a link that loops back', async () => {
    const a = await newProduct();
    const b = await newProduct({ looseProductId: a });
    const c = await newProduct({ looseProductId: b });

    assert({
      given: "linking a product to a loose product whose own chain leads back to it, directly (A↔B) or through another (A→C→B→A)",
      should: 'refuse both with a 400',
      actual: [await statusOf(products.setLooseProductLink(a, b, 10)), await statusOf(products.setLooseProductLink(a, c, 10))],
      expected: [400, 400],
    });
  });
});

describe('ProductsService search keywords (Postgres)', () => {
  test('a body that is not a list of words', async () => {
    const product = await newProduct();
    const category = await prisma.category.create({ data: { name: `Categoría-${Math.random()}` } });
    const statuses = [];
    for (const list of ['tylenol', [1, 2], null] as any[]) {
      statuses.push(await statusOf(products.setSearchAliases(product, list)));
      statuses.push(await statusOf(products.setCategorySymptomKeywords(category.id, list)));
    }

    assert({
      given: 'aliases and symptom keywords sent as a string, a list of numbers and null',
      should: 'refuse each with a 400 instead of a 500',
      actual: statuses,
      expected: [400, 400, 400, 400, 400, 400],
    });
  });
});

describe('ProductsService.setYastasMapping (Postgres)', () => {
  test('a product with stock', async () => {
    const product = await newProduct();
    await prisma.inventory.create({ data: { productId: product, locationId: centro, quantity: 4, unitCost: 10, receivedAt: new Date('2026-10-01') } });
    const employee = await prisma.employee.create({ data: { name: 'Cajera' } as any });

    assert({
      given: 'a product with stock marked as a Yastás service item',
      should: 'refuse with a 400 and keep tracking its inventory',
      actual: [
        await statusOf(products.setYastasMapping(product, employee.id)),
        (await prisma.product.findUnique({ where: { id: product } }))?.tracksInventory,
      ],
      expected: [400, true],
    });
  });
});
