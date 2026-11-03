/**
 * The box's barcode (Square's variation `upc`, stored as Product.gtin) against
 * a real Postgres engine (see testing/pglite.ts): what the scanner matches and
 * what the phone's cache receives.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
}, 120_000);

afterAll(() => stop?.());

const code = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

describe('ProductsService.getProducts exact search', () => {
  test('a scanned barcode', async () => {
    const gtin = code();
    const product = await prisma.product.create({ data: { name: 'Buscapina 10 mg', sku: `SKU-${code()}`, gtin } });
    const result = await new ProductsService(prisma).getProducts(centro, { search: gtin, exact: true });

    assert({
      given: "a scan of a product's barcode, which is not its SKU",
      should: 'find that product as an exact match',
      actual: [result.exactMatch, result.data.map((p) => p.id)],
      expected: [true, [product.id]],
    });
  });

  test('a barcode two products share', async () => {
    const gtin = code();
    const first = await prisma.product.create({ data: { name: 'Caja A', gtin } });
    const second = await prisma.product.create({ data: { name: 'Caja B', gtin } });
    const result = await new ProductsService(prisma).getProducts(centro, { search: gtin, exact: true });

    assert({
      given: 'two products saved with the same barcode, as Square allows',
      should: 'keep both and return both as exact matches',
      actual: [result.exactMatch, result.data.map((p) => p.id).sort()],
      expected: [true, [first.id, second.id].sort()],
    });
  });

  test('a scanned SKU', async () => {
    const sku = `abc-${code()}`;
    const product = await prisma.product.create({ data: { name: 'Gel', sku } });
    const result = await new ProductsService(prisma).getProducts(centro, { search: sku.toUpperCase(), exact: true });

    assert({
      given: 'a scan of a SKU in different letter case',
      should: 'still find it as an exact match',
      actual: [result.exactMatch, result.data.map((p) => p.id)],
      expected: [true, [product.id]],
    });
  });
});

describe('ProductsService.syncProducts', () => {
  test('a barcode set after the last sync', async () => {
    const products = new ProductsService(prisma);
    const product = await prisma.product.create({ data: { name: `Sin código ${code()}` } });
    let cursor: string | undefined;
    for (let page; !page || page.hasMore; cursor = page.cursor) page = await products.syncProducts(centro, cursor);

    const gtin = code();
    await prisma.product.update({ where: { id: product.id }, data: { gtin } });
    const next = await products.syncProducts(centro, cursor);

    assert({
      given: 'a barcode added to a product the phone already has',
      should: 'send the product again with its barcode',
      actual: next.data.filter((p) => p.id === product.id).map((p) => p.gtin),
      expected: [gtin],
    });
  });
});
