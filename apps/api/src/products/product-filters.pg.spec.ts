/**
 * The product list filtered on the server (stock and margin chips), against a real
 * Postgres engine (see testing/pglite.ts). A filtered list must hold exactly the
 * products its chip counts, across all pages, not just the pages already loaded.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService, ProductListFilter } from './products.service';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

/**
 * A store of its own with: out of stock (0), low stock (5), in stock (20), and a
 * product in stock priced at 10 that cost 9.50 (5% margin). Every product has a price.
 */
async function storeWithStockLevels() {
  const { id: store } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Filtros' } });
  const product = async (name: string, quantity: number, priceCents: number, unitCost: number) => {
    const { id } = await prisma.product.create({ data: { name: `${name}-${Math.random()}`, soldOnlyAtLocationId: store } });
    await prisma.catalogMapping.create({ data: { squareVariationId: `v-${id}`, productId: id, locationId: store, priceCents } });
    if (quantity > 0) {
      await prisma.inventory.create({ data: { productId: id, locationId: store, quantity, unitCost, receivedAt: new Date('2026-10-01') } });
    }
    return id;
  };
  return {
    store,
    out: await product('Agotado', 0, 5000, 20),
    low: await product('Poco', 5, 5000, 20),
    plenty: await product('Mucho', 20, 5000, 20),
    thinMargin: await product('Margen', 30, 1000, 9.5),
  };
}

const counts = (products: ProductsService, store: string) => products.getProductCounts(store).then((r) => r.data);
const listed = async (products: ProductsService, store: string, filter: ProductListFilter) => {
  const result = await products.getProducts(store, { filter, limit: 50 });
  return { ids: result.data.map((p) => p.id).sort(), total: result.totalCount };
};

describe('ProductsService.getProducts with a filter', () => {
  test('stock and margin filters', async () => {
    const products = new ProductsService(prisma);
    const { store, out, low, plenty, thinMargin } = await storeWithStockLevels();
    const c = await counts(products, store);

    assert({
      given: 'a store with products out of stock, low, in stock, and one with a 5% margin',
      should: 'list exactly the matching products for each filter',
      actual: [
        (await listed(products, store, 'outOfStock')).ids,
        (await listed(products, store, 'lowStock')).ids,
        (await listed(products, store, 'inStock')).ids,
        (await listed(products, store, 'lowMargin')).ids,
      ],
      expected: [[out], [low], [plenty, thinMargin].sort(), [thinMargin]],
    });

    assert({
      given: 'the same store',
      should: "give each filtered list the total its chip counts",
      actual: [
        (await listed(products, store, 'outOfStock')).total,
        (await listed(products, store, 'lowStock')).total,
        (await listed(products, store, 'inStock')).total,
        (await listed(products, store, 'lowMargin')).total,
      ],
      expected: [c.outOfStock, c.lowStock, c.total - c.outOfStock - c.lowStock, c.lowMargin],
    });
  });

  test('pages of a filtered list', async () => {
    const products = new ProductsService(prisma);
    const { store, low } = await storeWithStockLevels();
    const second = await prisma.product.create({ data: { name: `Poco2-${Math.random()}`, soldOnlyAtLocationId: store } });
    await prisma.inventory.create({ data: { productId: second.id, locationId: store, quantity: 3, unitCost: 1, receivedAt: new Date('2026-10-01') } });
    const page = (n: number) => products.getProducts(store, { filter: 'lowStock', page: n, limit: 1 });
    const [one, two] = [await page(1), await page(2)];

    assert({
      given: 'two low-stock products listed one per page',
      should: 'give one on each page, with total 2 and hasMore only on the first',
      actual: [[one.data.length, two.data.length], [...one.data, ...two.data].map((p) => p.id).sort(), [one.totalCount, one.hasMore, two.hasMore]],
      expected: [[1, 1], [low, second.id].sort(), [2, true, false]],
    });
  });

  test('a filter together with only some products', async () => {
    const products = new ProductsService(prisma);
    const { store, low, plenty } = await storeWithStockLevels();
    const result = await products.getProducts(store, { onlyIds: [plenty, low, 'missing'] });

    assert({
      given: 'a list limited to some product ids (what the aging service flagged), one of them unknown',
      should: 'list just those products, in the order given',
      actual: [result.data.map((p) => p.id), result.totalCount],
      expected: [[plenty, low], 2],
    });
  });
});
