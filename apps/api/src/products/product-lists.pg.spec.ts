/**
 * What each store's product lists show, against a real Postgres engine (see
 * testing/pglite.ts): one-store products, dashboard counts, and search limits.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';
import { CatalogSearchService } from './catalog-search.service';
import { MedicationEquivalenceService } from './medication-equivalence.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let norte: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  ({ id: norte } = await prisma.location.create({ data: { squareId: 'SQ-NORTE', name: 'Norte' } }));
}, 120_000);

afterAll(() => stop?.());

const services = () => {
  const equivalence = new MedicationEquivalenceService(prisma);
  return { products: new ProductsService(prisma), search: new CatalogSearchService(prisma, equivalence), equivalence };
};

describe('a product sold only at one store', () => {
  /** A medication sold everywhere and its equivalent, a toy-like product sold only at Norte. */
  async function oneStoreSetup() {
    const tag = `Unico${Math.random().toString(36).slice(2, 8)}`;
    const definition = await prisma.medicationDefinition.create({ data: { name: tag, form: 'TABLET', route: 'ORAL', strength: '1 mg' } });
    const everywhere = await prisma.product.create({ data: { name: `${tag} Todas`, medicationDefinitionId: definition.id } });
    const onlyNorte = await prisma.product.create({ data: { name: `${tag} Norte`, medicationDefinitionId: definition.id, soldOnlyAtLocationId: norte } });
    return { tag, everywhere: everywhere.id, onlyNorte: onlyNorte.id };
  }

  test('in the product list, catalog search and equivalents', async () => {
    const { products, search, equivalence } = services();
    const { tag, everywhere, onlyNorte } = await oneStoreSetup();
    const listed = async (locationId?: string) => (await products.getProducts(locationId, { search: tag })).data.map((p) => p.id).sort();
    const searched = async (locationId: string) => (await search.search(tag, locationId)).requested.map((p) => p.id).sort();
    const equivalents = async (locationId: string) => (await equivalence.findEquivalentProducts(everywhere, locationId)).map((p) => p.id);

    assert({
      given: 'a product sold only at Norte next to one sold everywhere',
      should: "leave it out of Centro's list, search and equivalents, and show it at Norte and in the owner's every-store list",
      actual: [await listed(centro), await searched(centro), await equivalents(centro), await listed(norte), await searched(norte), await equivalents(norte), await listed()],
      expected: [[everywhere], [everywhere], [], [everywhere, onlyNorte].sort(), [everywhere, onlyNorte].sort(), [onlyNorte], [everywhere, onlyNorte].sort()],
    });
  });

  test('in the dashboard counts', async () => {
    const { products } = services();
    const before = { centro: (await products.getProductCounts(centro)).data.total, norte: (await products.getProductCounts(norte)).data.total };
    await prisma.product.create({ data: { name: `Juguete-${Math.random()}`, soldOnlyAtLocationId: norte } });

    assert({
      given: 'a new product sold only at Norte',
      should: "count it at Norte only",
      actual: [(await products.getProductCounts(centro)).data.total - before.centro, (await products.getProductCounts(norte)).data.total - before.norte],
      expected: [0, 1],
    });
  });
});

describe('ProductsService.getProductCounts', () => {
  test('Yastás and discontinued products', async () => {
    const { products } = services();
    const before = (await products.getProductCounts(centro)).data;
    await prisma.product.create({ data: { name: `Yastas-${Math.random()}`, tracksInventory: false } });
    await prisma.product.create({ data: { name: `Descontinuado-${Math.random()}`, isDiscontinued: true } });
    const after = (await products.getProductCounts(centro)).data;

    assert({
      given: 'a Yastás service product and a discontinued product, neither with stock',
      should: 'leave both out of the total and the out-of-stock count',
      actual: [after.total - before.total, after.outOfStock - before.outOfStock],
      expected: [0, 0],
    });
  });
});

describe('CatalogSearchService.search', () => {
  test('a query matching more than the result limit', async () => {
    const { search } = services();
    const tag = `Tope${Math.random().toString(36).slice(2, 8)}`;
    for (let start = 0; start < 520; start += 100) {
      await prisma.product.createMany({ data: Array.from({ length: Math.min(100, 520 - start) }, (_, i) => ({ name: `${tag} ${start + i}` })) });
    }

    assert({
      given: 'a query that matches 520 products',
      should: 'return at most 500',
      actual: (await search.search(tag, centro)).requested.length,
      expected: 500,
    });
  });
});

describe('ProductsService.syncUnsyncedProducts', () => {
  test('a placeholder with no price', async () => {
    const products = new ProductsService(prisma);
    const upsert = vi.fn().mockResolvedValue({});
    products['squareClient'] = { catalog: { object: { upsert } } } as any;
    const product = await prisma.product.create({ data: { name: `SinPrecio-${Math.random()}` } });
    await prisma.catalogMapping.create({ data: { squareVariationId: `local_${product.id}`, productId: product.id, locationId: centro } });

    const result = await products.syncUnsyncedProducts(centro);
    const outcome = result.results.find((r) => r.productId === product.id);

    assert({
      given: 'a product waiting to go to Square with no selling price',
      should: 'skip it with a Spanish reason instead of creating a $0 Square item',
      actual: [outcome?.success, /precio/.test(outcome?.error ?? ''), upsert.mock.calls.filter(([r]) => r.object.itemData?.name === product.name).length],
      expected: [false, true, 0],
    });
  });
});
