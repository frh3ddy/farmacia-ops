/**
 * Creating a product against a real Postgres engine (see testing/pglite.ts)
 * and a recorded Square client: nothing is left behind in either when it fails.
 */
import { assert } from 'riteway/vitest';
import { randomUUID } from 'crypto';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService, type CreateProductInput } from './products.service';
import { StockCountService } from '../inventory/stock-count.service';
import { InventoryAdjustmentService } from '../inventory/inventory-adjustment.service';

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

  test('references, fixed values and true/false fields that are not valid', async () => {
    const { products, square } = productsWithSquare();
    const labName = `Lab-${Math.random()}`;
    const medication = { name: 'Paracetamol', form: 'TABLET', route: 'ORAL', strength: '500 mg', activeIngredients: [{ name: `Activo-${labName}` }] };
    const statuses = [];
    for (const input of [
      { categoryId: 'no-such-category' },
      { labId: 'no-such-lab' },
      { medicationDefinitionId: 'no-such-definition' },
      { looseProductId: 'no-such-product' },
      { medicationType: 'HOMEOPATHIC' },
      { primaryPackaging: 'CRATE' },
      { secondaryPackaging: 'CRATE' },
      { medication: { ...medication, form: 'POTION' } },
      { medication: { ...medication, route: 'TELEPATHIC' } },
      { medication: { ...medication, activeIngredients: [{ name: '' }] } },
      { requiresPrescription: 'yes' },
      { isControlled: 1 },
      { syncToSquare: 'no' },
      { soldAtAllLocations: 'no' },
      { sku: 7501234567890 },
    ] as any[]) {
      statuses.push(await statusOf(create(products, { labName, medication, ...input })));
    }

    assert({
      given: 'a missing category, laboratory, definition or loose product, an unknown type, packaging, form or route, a nameless ingredient, a non-boolean flag, and a numeric SKU',
      should: 'refuse each with a 400 before creating anything in Square or the database',
      actual: [
        statuses,
        square.catalog.object.upsert.mock.calls.length,
        await prisma.laboratory.count({ where: { name: labName } }),
        await prisma.activeIngredient.count({ where: { name: `Activo-${labName}` } }),
      ],
      expected: [Array(15).fill(400), 0, 0, 0],
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

  test('sold at every store or at one', async () => {
    const { products, square } = productsWithSquare();
    const everywhere = `Todas-${Math.random()}`;
    const toy = `Juguete-${Math.random()}`;
    await create(products, { name: everywhere });
    await create(products, { name: toy, soldAtAllLocations: false });
    const presence = (name: string) =>
      square.catalog.object.upsert.mock.calls
        .filter(([r]: any) => r.object.itemData.name === name)
        .map(([r]: any) => [
          r.object.presentAtAllLocations,
          r.object.presentAtLocationIds,
          r.object.itemData.variations[0].presentAtAllLocations,
          r.object.itemData.variations[0].presentAtLocationIds,
        ]);

    assert({
      given: 'a product left at the default, then one sold only at Centro',
      should: 'create the first sold everywhere, and the second with its item and variation present only at Centro',
      actual: [
        presence(everywhere),
        presence(toy),
        (await prisma.product.findFirst({ where: { name: toy } }))?.soldOnlyAtLocationId,
      ],
      expected: [
        [[undefined, undefined, undefined, undefined]],
        [[false, ['SQ-CENTRO'], false, ['SQ-CENTRO']]],
        centro,
      ],
    });
  });

  test('the mapping a Square sale is matched by', async () => {
    const { products } = productsWithSquare();
    const everywhere = await create(products, {});
    const toy = await create(products, { soldAtAllLocations: false });
    const mappingStores = (productId: string) =>
      prisma.catalogMapping.findMany({ where: { productId }, select: { locationId: true } }).then((ms) => ms.map((m) => m.locationId));

    assert({
      given: 'a product sold at every store and one sold only at Centro, both created at Centro',
      should: 'map the first with no store, so a sale at any store matches it, and the second to Centro',
      actual: [await mappingStores(everywhere.product!.id), await mappingStores(toy.product!.id)],
      expected: [[null], [centro]],
    });

    await products.updatePrice({ productId: everywhere.product!.id, sellingPrice: 45, locationId: norte, syncToSquare: false });
    const prices = await prisma.catalogMapping.findMany({
      where: { productId: everywhere.product!.id },
      orderBy: { createdAt: 'asc' },
      select: { locationId: true, priceCents: true },
    });

    assert({
      given: 'a later price change at Norte only',
      should: "add Norte's own price and leave the all-stores price as it was",
      actual: prices.map((p) => [p.locationId, Number(p.priceCents)]),
      expected: [[null, 3000], [norte, 4500]],
    });
  });

  test('sold at one store that is not in Square', async () => {
    const { products, square } = productsWithSquare();
    const { id: bodega } = await prisma.location.create({ data: { name: `Bodega-${Math.random()}` } });
    const result = await create(products, { locationId: bodega, soldAtAllLocations: false });

    assert({
      given: 'a product sold only at a store with no Square location',
      should: 'save it without creating it in Square, and say why',
      actual: [square.catalog.object.upsert.mock.calls.length, result.squareSynced, /no está en Square/.test(result.message)],
      expected: [0, false, true],
    });
  });

  test('a medication without its ingredient list', async () => {
    const { products } = productsWithSquare();
    const labName = `Lab-${Math.random()}`;
    const statuses = [
      await statusOf(create(products, { labName, medication: { name: 'Paracetamol', form: 'TABLET', route: 'ORAL', strength: '500 mg' } } as any)),
      await statusOf(create(products, { labName, costPrice: 'abc', medication: { name: 'Paracetamol', form: 'TABLET', route: 'ORAL', strength: '500 mg', activeIngredients: [{ name: `Activo-${labName}` }] } } as any)),
    ];

    assert({
      given: 'a new laboratory with a medication missing its ingredient list, then with a bad cost',
      should: 'refuse both with a 400 before creating the laboratory or ingredient',
      actual: [statuses, await prisma.laboratory.count({ where: { name: labName } }), await prisma.activeIngredient.count({ where: { name: `Activo-${labName}` } })],
      expected: [[400, 400], 0, 0],
    });
  });

  test('the same retry sent twice at once', async () => {
    const { products, square } = productsWithSquare();
    const clientRequestId = randomUUID();
    const name = `Doble-${Math.random()}`;
    const [first, second] = await Promise.all([
      create(products, { name, clientRequestId }),
      create(products, { name, clientRequestId }),
    ]);

    assert({
      given: 'two creates with one clientRequestId arriving together',
      should: "answer both with the one product, and delete the Square item the losing request made",
      actual: [first.product?.id, second.product?.id, await productsNamed(name), square.catalog.batchDelete.mock.calls.length],
      expected: [clientRequestId, clientRequestId, 1, square.catalog.object.upsert.mock.calls.length - 1],
    });
  });

  test('a name with spaces around it', async () => {
    const { products } = productsWithSquare();
    const result = await create(products, { name: '  Gel  ' });

    assert({
      given: 'a name with spaces around it',
      should: 'report the name the product was saved under',
      actual: result.message,
      expected: 'Producto "Gel" creado y enviado a Square',
    });
  });
});

describe('ProductsService.createProduct with a barcode', () => {
  const upcSent = (square: ReturnType<typeof productsWithSquare>['square'], call = 0) =>
    (square.catalog.object.upsert.mock.calls[call] as any)?.[0].object.itemData.variations[0].itemVariationData.upc;

  test('a scanned barcode', async () => {
    const { products, square } = productsWithSquare();
    const gtin = `750${Math.floor(Math.random() * 1e10)}`.padEnd(13, '0').slice(0, 13);
    const { product } = await create(products, { gtin });

    assert({
      given: 'a new product created with a scanned 13-digit barcode and no SKU',
      should: "save it as the barcode, not the SKU, and send it as the Square variation's upc",
      actual: [product?.gtin, product?.sku, upcSent(square)],
      expected: [gtin, null, gtin],
    });
  });

  test('a 13-digit barcode read as 14 digits', async () => {
    const { products, square } = productsWithSquare();
    const { product } = await create(products, { gtin: '03664798067460' });

    assert({
      given: 'a barcode read as 14 digits: a 0 before the printed 13',
      should: 'save and send the printed 13 digits, which the register scans',
      actual: [product?.gtin, upcSent(square)],
      expected: ['3664798067460', '3664798067460'],
    });
  });

  test('a barcode another product has', async () => {
    const { products } = productsWithSquare();
    const gtin = '7501234567890';
    await create(products, { gtin });
    const status = await statusOf(create(products, { gtin }));

    assert({
      given: 'a second product created with a barcode the first one has',
      should: 'still create it',
      actual: status,
      expected: 201,
    });
  });

  test('a barcode that is not a GTIN', async () => {
    const { products, square } = productsWithSquare();
    const name = `MalCodigo-${Math.random()}`;
    const statuses = [
      await statusOf(create(products, { name, gtin: '12345' })),
      await statusOf(create(products, { name, gtin: '75012345678AB' })),
      await statusOf(create(products, { name, gtin: 7501234567890 as any })),
    ];

    assert({
      given: 'a barcode of the wrong length, one with letters, and one sent as a number',
      should: 'refuse each with a 400 before writing to Square or the database',
      actual: [statuses, square.catalog.object.upsert.mock.calls.length, await productsNamed(name)],
      expected: [[400, 400, 400], 0, 0],
    });
  });

  test('a product sent to Square later', async () => {
    const { products, square } = productsWithSquare();
    const gtin = '3664798067460';
    const { product } = await create(products, { gtin, syncToSquare: false });
    await products.syncUnsyncedProducts(centro);
    const call = square.catalog.object.upsert.mock.calls.findIndex((c: any) => c[0].object.itemData.name === product?.name);

    assert({
      given: 'a product saved with a barcode while Square was off, then swept to Square',
      should: 'send its barcode with the new Square item',
      actual: upcSent(square, call),
      expected: gtin,
    });
  });
});

describe('ProductsService.createProduct during a Conteo inicial', () => {
  /** A cut-over store with its own Square id. */
  async function store() {
    const { id } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Lolita' } });
    await prisma.cutoverLock.create({ data: { locationId: id, cutoverDate: new Date('2026-09-01') } });
    return id;
  }

  test('a product created with stock while the count is open', async () => {
    const locationId = await store();
    const counts = new StockCountService(prisma, new InventoryAdjustmentService(prisma));
    const { id } = await counts.start(locationId, 'owner');
    const { products } = productsWithSquare();
    const { product } = await create(products, { locationId, initialStock: 5, costPrice: 10 });

    const listed = (await counts.uncounted(id, locationId)).some((u) => u.productId === product!.id);
    await counts.zero(id, locationId, [product!.id], 'owner');
    const entry = await prisma.stockCountEntry.findUnique({ where: { stockCountId_productId: { stockCountId: id, productId: product!.id } } });

    assert({
      given: 'a product created with 5 units at a store whose Conteo inicial is open',
      should: 'count it as counted at 5 (from 0, no adjustment), leave it off No contados, and keep its 5 through Poner en 0',
      actual: [
        listed,
        [entry?.countedQuantity, entry?.previousQuantity, entry?.adjustmentId],
        (await prisma.inventory.aggregate({ where: { productId: product!.id }, _sum: { quantity: true } }))._sum.quantity,
      ],
      expected: [false, [5, 0, null], 5],
    });
    assert({
      given: 'a product counted by being created during the count',
      should: 'stamp its first count with the same time as the count itself',
      actual: entry?.firstCountedAt.getTime(),
      expected: entry?.countedAt.getTime(),
    });
  });

  test('a product created with stock and no count open', async () => {
    const locationId = await store();
    const { products } = productsWithSquare();
    const { product } = await create(products, { locationId, initialStock: 5, costPrice: 10 });

    assert({
      given: 'a product created with stock at a store with no Conteo inicial open',
      should: 'record no count',
      actual: await prisma.stockCountEntry.count({ where: { productId: product!.id } }),
      expected: 0,
    });
  });
});

describe('ProductsService.createProduct with lote and caducidad', () => {
  const batchOf = (productId: string) =>
    prisma.inventory.findFirst({ where: { productId }, select: { lotNumber: true, expiryDate: true } });

  test('initial stock with its lote and caducidad', async () => {
    const { products } = productsWithSquare();
    const { product } = await create(products, { initialStock: 5, costPrice: 10, batchNumber: '  L-123  ', expiryDate: '2027-01-31' });

    assert({
      given: 'initial stock with a lote padded with spaces and a caducidad day',
      should: 'put the trimmed lote and that Mexico City day on the stock batch',
      actual: await batchOf(product!.id),
      expected: { lotNumber: 'L-123', expiryDate: new Date('2027-01-31T12:00:00.000-06:00') },
    });
  });

  test('an empty lote', async () => {
    const { products } = productsWithSquare();
    const { product } = await create(products, { initialStock: 5, costPrice: 10, batchNumber: '   ', expiryDate: '2027-01-31' });

    assert({
      given: 'a lote of only spaces',
      should: 'save no lote',
      actual: (await batchOf(product!.id))?.lotNumber,
      expected: null,
    });
  });

  test('a lote longer than a count lot allows', async () => {
    const { products } = productsWithSquare();
    const { product } = await create(products, { initialStock: 5, costPrice: 10, batchNumber: 'x'.repeat(150) });

    assert({
      given: 'a lote of 150 characters',
      should: 'keep its first 100, as a count lot does',
      actual: (await batchOf(product!.id))?.lotNumber?.length,
      expected: 100,
    });
  });

  test('lote or caducidad without initial stock', async () => {
    const { products, square } = productsWithSquare();
    const name = `SinStock-${Math.random()}`;
    const statuses = [
      await statusOf(create(products, { name, batchNumber: 'L-1' })),
      await statusOf(create(products, { name, expiryDate: '2027-01-31' })),
      await statusOf(create(products, { name, initialStock: 0, costPrice: 10, expiryDate: '2027-01-31' })),
    ];

    assert({
      given: 'a lote or a caducidad with no initial stock to put them on',
      should: 'refuse with a 400 before creating anything',
      actual: [statuses, square.catalog.object.upsert.mock.calls.length, await productsNamed(name)],
      expected: [[400, 400, 400], 0, 0],
    });
  });

  test('a caducidad or lote that is not valid', async () => {
    const { products } = productsWithSquare();
    const statuses = [
      await statusOf(create(products, { initialStock: 5, costPrice: 10, expiryDate: '31/01/2027' })),
      await statusOf(create(products, { initialStock: 5, costPrice: 10, expiryDate: '2027-02-31x' })),
      await statusOf(create(products, { initialStock: 5, costPrice: 10, batchNumber: 123 as any })),
    ];

    assert({
      given: 'a caducidad that is not a YYYY-MM-DD day, or a lote that is not text',
      should: 'refuse with a 400',
      actual: statuses,
      expected: [400, 400, 400],
    });
  });

  test('created with lote and caducidad during a Conteo inicial', async () => {
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Lolita' } });
    await prisma.cutoverLock.create({ data: { locationId, cutoverDate: new Date('2026-09-01') } });
    const counts = new StockCountService(prisma, new InventoryAdjustmentService(prisma));
    await counts.start(locationId, 'owner');
    const { products } = productsWithSquare();
    const { product } = await create(products, { locationId, initialStock: 5, costPrice: 10, batchNumber: 'L-9', expiryDate: '2027-03-15' });

    assert({
      given: 'a product created with stock, lote and caducidad while the count is open',
      should: 'show that lot to the count form',
      actual: await counts.lots(product!.id, locationId),
      expected: [{ quantity: 5, expiryDate: '2027-03-15', batchNumber: 'L-9' }],
    });
  });
});
