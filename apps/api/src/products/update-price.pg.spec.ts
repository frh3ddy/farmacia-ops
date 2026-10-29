/**
 * Price changes against a real Postgres engine (see testing/pglite.ts) and a
 * recorded Square catalog: what is sent to Square and which cached prices change.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';

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

/**
 * A variation as Square returns it: sold everywhere but one location, $30 base,
 * Norte with its own $35 price and inventory tracking switched off there.
 */
const variation = (id: string) => ({
  type: 'ITEM_VARIATION',
  id,
  version: BigInt(7),
  presentAtAllLocations: true,
  absentAtLocationIds: ['SQ-CERRADA'],
  itemVariationData: {
    itemId: 'ITEM-1',
    name: 'Regular',
    pricingType: 'FIXED_PRICING',
    priceMoney: { amount: BigInt(3000), currency: 'USD' },
    trackInventory: true,
    locationOverrides: [
      { locationId: 'SQ-NORTE', priceMoney: { amount: BigInt(3500), currency: 'USD' }, pricingType: 'FIXED_PRICING', trackInventory: false },
    ],
  },
});

/** The service over a recorded Square catalog. */
function productsWithSquare() {
  const products = new ProductsService(prisma);
  const catalog = {
    object: {
      get: vi.fn(async ({ objectId }: { objectId: string }) => ({ object: variation(objectId) })),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
  products['squareClient'] = { catalog } as any;
  return { products, catalog };
}

/** Square items created through the recorded catalog (a variation update is not one). */
const itemsCreated = (catalog: ReturnType<typeof productsWithSquare>['catalog']) =>
  catalog.object.upsert.mock.calls.filter(([r]) => r.object.type === 'ITEM').length;

async function productWithMappings(mappings: Array<{ squareVariationId: string; locationId: string | null; priceCents: number }>) {
  const product = await prisma.product.create({ data: { name: `Producto-${Math.random()}` } });
  for (const m of mappings) {
    await prisma.catalogMapping.create({ data: { ...m, productId: product.id, currency: 'USD' } });
  }
  return product.id;
}

const cachedPrices = async (productId: string) =>
  (await prisma.catalogMapping.findMany({ where: { productId }, orderBy: { createdAt: 'asc' } }))
    .map((m) => [m.squareVariationId, m.locationId === centro ? 'centro' : m.locationId === norte ? 'norte' : null, Number(m.priceCents)]);

describe('ProductsService.updatePrice (Postgres)', () => {
  test("one location's price", async () => {
    const { products, catalog } = productsWithSquare();
    const productId = await productWithMappings([{ squareVariationId: 'VAR-1', locationId: norte, priceCents: 3500 }]);

    const result = await products.updatePrice({ productId, sellingPrice: 32.5, locationId: centro });
    const sent = catalog.object.upsert.mock.calls[0][0].object;

    assert({
      given: 'a price for Centro on a product whose only Square mapping is tagged with Norte',
      should: "add Centro's own price and leave the base price, Norte's override and where the item is sold as they were",
      actual: [sent.presentAtAllLocations, sent.absentAtLocationIds, sent.presentAtLocationIds, sent.version, sent.itemVariationData.priceMoney, sent.itemVariationData.locationOverrides],
      expected: [
        true,
        ['SQ-CERRADA'],
        undefined,
        BigInt(7),
        { amount: BigInt(3000), currency: 'USD' },
        [
          { locationId: 'SQ-NORTE', priceMoney: { amount: BigInt(3500), currency: 'USD' }, pricingType: 'FIXED_PRICING', trackInventory: false },
          { locationId: 'SQ-CENTRO', priceMoney: { amount: BigInt(3250), currency: 'USD' }, pricingType: 'FIXED_PRICING' },
        ],
      ],
    });
    assert({
      given: 'the same price change',
      should: "cache Centro's price under the real Square item, keep Norte's, and create no second Square item",
      actual: [await cachedPrices(productId), itemsCreated(catalog), result.squareSynced],
      expected: [[['VAR-1', 'norte', 3500], ['VAR-1', 'centro', 3250]], 0, true],
    });
  });

  test('every location', async () => {
    const { products, catalog } = productsWithSquare();
    const productId = await productWithMappings([
      { squareVariationId: 'VAR-2', locationId: null, priceCents: 3000 },
      { squareVariationId: 'VAR-2', locationId: norte, priceCents: 3500 },
    ]);

    await products.updatePrice({ productId, sellingPrice: 40, locationId: centro, applyToAllLocations: true });
    const sent = catalog.object.upsert.mock.calls[0][0].object;

    assert({
      given: 'a price for every location',
      should: "change the base price and drop Norte's price but keep its inventory setting, without changing where the item is sold",
      actual: [sent.presentAtAllLocations, sent.absentAtLocationIds, sent.itemVariationData.priceMoney, sent.itemVariationData.locationOverrides],
      expected: [
        true,
        ['SQ-CERRADA'],
        { amount: BigInt(4000), currency: 'USD' },
        [{ locationId: 'SQ-NORTE', trackInventory: false }],
      ],
    });
    assert({
      given: 'the same price change',
      should: 'cache the new price on every mapping',
      actual: await cachedPrices(productId),
      expected: [['VAR-2', null, 4000], ['VAR-2', 'norte', 4000]],
    });
  });
});

describe('ProductsService.syncUnsyncedProducts (Postgres)', () => {
  test('a placeholder next to a real Square item', async () => {
    const { products, catalog } = productsWithSquare();
    const productId = await productWithMappings([
      { squareVariationId: 'VAR-3', locationId: norte, priceCents: 3000 },
      { squareVariationId: `local_placeholder-${Math.random()}`, locationId: centro, priceCents: 3200 },
    ]);

    const result = await products.syncUnsyncedProducts(centro);

    assert({
      given: "a Centro placeholder for a product already in Square under Norte's mapping",
      should: 'point the placeholder at the real Square item instead of creating a second one',
      actual: [itemsCreated(catalog), result.synced, await cachedPrices(productId)],
      expected: [0, 1, [['VAR-3', 'norte', 3000], ['VAR-3', 'centro', 3200]]],
    });
  });
});

describe('ProductsService reads (Postgres)', () => {
  test('a product mapped only under another location', async () => {
    const products = new ProductsService(prisma);
    const before = (await products.getProductCounts(centro)).data;
    const productId = await productWithMappings([{ squareVariationId: 'VAR-4', locationId: norte, priceCents: 2500 }]);

    const { data } = await products.getProduct(productId, centro);
    const after = (await products.getProductCounts(centro)).data;

    assert({
      given: "a product whose only Square mapping is tagged with Norte, read at Centro",
      should: 'show it as in Square with its price, and count it as synced, not pending',
      actual: [data.hasSquareSync, data.sellingPrice, after.synced - before.synced, after.local - before.local],
      expected: [true, 25, 1, 0],
    });
  });
});
