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

/** The service over a recorded Square catalog; `upsert` is what Square answers a write with. */
function productsWithSquare(upsert = vi.fn().mockResolvedValue({})) {
  const products = new ProductsService(prisma);
  const catalog = {
    object: {
      get: vi.fn(async ({ objectId }: { objectId: string }) => ({ object: variation(objectId) })),
      upsert,
    },
  };
  products['squareClient'] = { catalog } as any;
  return { products, catalog };
}

/** Square items created through the recorded catalog (a variation update is not one), optionally only those named `name`. */
const itemsCreated = (catalog: ReturnType<typeof productsWithSquare>['catalog'], name?: string) =>
  catalog.object.upsert.mock.calls.filter(([r]) => r.object.type === 'ITEM' && (!name || r.object.itemData.name === name)).length;

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

describe('ProductsService.updatePrice when Square fails (Postgres)', () => {
  test('Square rejecting the change', async () => {
    const { products } = productsWithSquare(vi.fn().mockRejectedValue(new Error('Square is down')));
    const inSquare = await productWithMappings([{ squareVariationId: `VAR-F-${Math.random()}`, locationId: null, priceCents: 3000 }]);
    const localOnly = await productWithMappings([{ squareVariationId: `local_f-${Math.random()}`, locationId: centro, priceCents: 3000 }]);

    const statuses = [];
    for (const [productId, applyToAllLocations] of [[inSquare, true], [inSquare, false], [localOnly, false]] as const) {
      statuses.push(await products.updatePrice({ productId, sellingPrice: 40, locationId: centro, applyToAllLocations }).then(() => 200, (e: any) => e.status));
    }

    assert({
      given: 'Square failing a price for every store, for one store, and the first price that creates a local product in Square',
      should: 'refuse each with a 502 and leave every stored price as it was',
      actual: [statuses, (await cachedPrices(inSquare)).map(([, , cents]) => cents), (await cachedPrices(localOnly)).map(([, , cents]) => cents)],
      expected: [[502, 502, 502], [3000], [3000]],
    });
  });

  test('a store with no Square location', async () => {
    const { products, catalog } = productsWithSquare();
    const { id: bodega } = await prisma.location.create({ data: { name: `Bodega-${Math.random()}` } });
    const productId = await productWithMappings([{ squareVariationId: `VAR-B-${Math.random()}`, locationId: null, priceCents: 3000 }]);

    const result = await products.updatePrice({ productId, sellingPrice: 45, locationId: bodega });

    assert({
      given: "one store's price at a store that has no Square location",
      should: 'save it in the app only, without calling Square, and say so',
      actual: [catalog.object.upsert.mock.calls.length, result.squareSynced, /solo en la app/.test(result.message)],
      expected: [0, false, true],
    });
  });
});

describe('ProductsService.updatePrice for Yastás (Postgres)', () => {
  test('a Yastás product', async () => {
    const { products, catalog } = productsWithSquare();
    const employee = await prisma.employee.create({ data: { name: `Cajera-${Math.random()}` } });
    const productId = await productWithMappings([{ squareVariationId: `VAR-Y-${Math.random()}`, locationId: null, priceCents: 0 }]);
    await prisma.catalogMapping.updateMany({ where: { productId }, data: { employeeId: employee.id } });

    const statuses = [];
    for (const applyToAllLocations of [true, false]) {
      statuses.push(await products.updatePrice({ productId, sellingPrice: 40, locationId: centro, applyToAllLocations }).then(() => 200, (e: any) => e.status));
    }

    assert({
      given: 'a price change, for every store and for one, on a Yastás product (no set price)',
      should: 'refuse both with a 400 and change nothing in Square or the database',
      actual: [statuses, catalog.object.upsert.mock.calls.length, (await cachedPrices(productId)).map(([, , cents]) => cents)],
      expected: [[400, 400], 0, [0]],
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
    const { name } = (await prisma.product.findUnique({ where: { id: productId } }))!;

    assert({
      given: "a Centro placeholder for a product already in Square under Norte's mapping",
      should: 'point the placeholder at the real Square item instead of creating a second one',
      actual: [itemsCreated(catalog, name), result.results.find((r) => r.productId === productId)?.success, await cachedPrices(productId)],
      expected: [0, true, [['VAR-3', 'norte', 3000], ['VAR-3', 'centro', 3200]]],
    });
  });
});

describe('A product sold at one store reaching Square later (Postgres)', () => {
  /** A web-created product (no Square item yet) sold only at Centro. */
  async function oneStoreProduct() {
    const product = await prisma.product.create({ data: { name: `Juguete-${Math.random()}`, soldOnlyAtLocationId: centro } });
    await prisma.catalogMapping.create({ data: { squareVariationId: `local_${product.id}`, productId: product.id, locationId: centro, priceCents: 9900, currency: 'USD' } });
    return product;
  }
  /** Where each Square item created under `name` is sold: item, then its variation. */
  const presence = (catalog: ReturnType<typeof productsWithSquare>['catalog'], name: string) =>
    catalog.object.upsert.mock.calls.filter(([r]: any) => r.object.itemData?.name === name).map(([r]: any) => [
      r.object.presentAtAllLocations,
      r.object.presentAtLocationIds,
      r.object.itemData.variations[0].presentAtAllLocations,
      r.object.itemData.variations[0].presentAtLocationIds,
    ]);

  test('from sync to Square and from its first price', async () => {
    const synced = productsWithSquare();
    const toy = await oneStoreProduct();
    await synced.products.syncUnsyncedProducts(centro);
    const priced = productsWithSquare();
    const otherToy = await oneStoreProduct();
    // The fake answers the create with no item, so the price change itself is refused.
    await priced.products.updatePrice({ productId: otherToy.id, sellingPrice: 99, locationId: centro }).catch(() => {});

    assert({
      given: 'a product sold only at Centro reaching Square through "sync to Square", then through its first price',
      should: 'create the Square item and its variation present only at Centro both times',
      actual: [...presence(synced.catalog, toy.name), ...presence(priced.catalog, otherToy.name)],
      expected: [
        [false, ['SQ-CENTRO'], false, ['SQ-CENTRO']],
        [false, ['SQ-CENTRO'], false, ['SQ-CENTRO']],
      ],
    });
  });
});

describe('ProductsService reads (Postgres)', () => {
  test("a product's recent receivings", async () => {
    const products = new ProductsService(prisma);
    const productId = await productWithMappings([]);
    for (const locationId of [centro, norte]) {
      const batch = await prisma.inventory.create({ data: { productId, locationId, quantity: 1, unitCost: 10, receivedAt: new Date('2026-10-01') } });
      await prisma.inventoryReceiving.create({ data: { productId, locationId, quantity: 1, unitCost: 10, totalCost: 10, inventoryBatchId: batch.id } });
    }

    const { data } = await products.getProduct(productId, centro);

    assert({
      given: 'receivings at Centro and Norte, read for Centro',
      should: "show only Centro's",
      actual: data.receivings.map((r) => r.locationId),
      expected: [centro],
    });
  });

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
