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

describe('ProductsService.getProducts search by the end of the barcode', () => {
  // A random 13-digit barcode, so tests in this file don't share endings by chance.
  const gtin13 = () => `750${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
  const ids = async (search: string, location = centro) =>
    (await new ProductsService(prisma).getProducts(location, { search })).data.map((p) => p.id);

  test('the last five digits', async () => {
    const gtin = gtin13();
    const product = await prisma.product.create({ data: { name: `Caja ${code()}`, gtin } });

    assert({
      given: "the last 5 digits of a product's barcode, which is not its SKU",
      should: 'find that product',
      actual: (await ids(gtin.slice(-5))).includes(product.id),
      expected: true,
    });
  });

  test('four digits and three digits', async () => {
    const gtin = gtin13();
    const product = await prisma.product.create({ data: { name: `Caja ${code()}`, gtin } });

    assert({
      given: 'the last 4 digits of the barcode',
      should: 'find the product',
      actual: (await ids(gtin.slice(-4))).includes(product.id),
      expected: true,
    });
    assert({
      given: 'only the last 3 digits of the barcode',
      should: 'not match by barcode, too short to mean one box',
      actual: (await ids(gtin.slice(-3))).includes(product.id),
      expected: false,
    });
  });

  test('digits from the middle of the barcode', async () => {
    const gtin = gtin13();
    const product = await prisma.product.create({ data: { name: `Caja ${code()}`, gtin } });

    assert({
      given: 'digits from the middle of the barcode, not its end',
      should: 'not find the product',
      actual: (await ids(gtin.slice(4, 9))).includes(product.id),
      expected: false,
    });
  });

  test('the whole barcode typed into the list search', async () => {
    const gtin = gtin13();
    const product = await prisma.product.create({ data: { name: `Caja ${code()}`, gtin } });

    assert({
      given: 'the full barcode typed into the product list search (not a scan)',
      should: 'find the product that only has it as its barcode',
      actual: await ids(gtin),
      expected: [product.id],
    });
  });

  test('two barcodes with the same ending', async () => {
    const end = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
    const first = await prisma.product.create({ data: { name: `Caja A ${code()}`, gtin: `75030${code().slice(-3)}${end}` } });
    const second = await prisma.product.create({ data: { name: `Caja B ${code()}`, gtin: `75099${code().slice(-3)}${end}` } });
    const found = await ids(end);

    assert({
      given: 'two products whose barcodes end in the same 5 digits',
      should: 'return both to choose from',
      actual: [first.id, second.id].every((id) => found.includes(id)),
      expected: true,
    });
  });

  test("another store's product", async () => {
    const { id: oriente } = await prisma.location.create({ data: { squareId: `SQ-OR-${code()}`, name: 'Oriente' } });
    const gtin = gtin13();
    const product = await prisma.product.create({ data: { name: `Caja ${code()}`, gtin, soldOnlyAtLocationId: oriente } });

    assert({
      given: "the end of the barcode of a product sold only at another store",
      should: 'not return it',
      actual: (await ids(gtin.slice(-5))).includes(product.id),
      expected: false,
    });
  });

  test('a number that is also a strength', async () => {
    const end = String(1000 + Math.floor(Math.random() * 9000));
    const byName = await prisma.product.create({ data: { name: `Vitamina C ${end} mg ${code()}` } });
    const byBarcode = await prisma.product.create({ data: { name: `Caja ${code()}`, gtin: `750${code().slice(-6)}${end}` } });
    const found = await ids(end);

    assert({
      given: "4 digits that end one product's barcode and are another's strength",
      should: 'return both, the barcode match first',
      actual: [found.indexOf(byBarcode.id) >= 0, found.indexOf(byBarcode.id) < found.indexOf(byName.id)],
      expected: [true, true],
    });
  });
});
