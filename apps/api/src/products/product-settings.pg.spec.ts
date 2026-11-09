/**
 * Product settings (loose link, search aliases, Yastás mapping, category
 * keywords) against a real Postgres engine (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';

let prisma: PrismaService;
let stop: () => Promise<void>;
let products: ProductsService;
let centro: string;
let oriente: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  products = new ProductsService(prisma);
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  ({ id: oriente } = await prisma.location.create({ data: { squareId: 'SQ-ORIENTE', name: 'Oriente' } }));
}, 120_000);

afterAll(() => stop?.());

const newProduct = async (data: object = {}) =>
  (await prisma.product.create({ data: { name: `Producto-${Math.random()}`, ...data } })).id;

const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: any) => e.status);

describe('ProductsService.setLooseProductLink (Postgres)', () => {
  const linkAt = (locationId: string, boxProductId: string, looseProductId: string) =>
    prisma.productLooseLink.create({ data: { locationId, boxProductId, looseProductId } });
  const looseAt = async (locationId: string, boxProductId: string) =>
    (await prisma.productLooseLink.findUnique({ where: { locationId_boxProductId: { locationId, boxProductId } } }))?.looseProductId ?? null;

  test('the link route', async () => {
    const box = await newProduct();
    const loose = await newProduct();
    const controller = new ProductsController(products, prisma, null as any, null as any, null as any);
    const req = { currentLocation: { locationId: oriente, role: 'MANAGER' } } as any;

    const { data } = await controller.setLooseProductLink(box, { looseProductId: loose, quantity: 10 }, req);

    assert({
      given: 'a link sent from a session at one store',
      should: "link the box at the session's store only, and return its suelto there",
      actual: [await looseAt(oriente, box), await looseAt(centro, box), data.product.looseProductId],
      expected: [loose, null, loose],
    });
  });

  test('a box quantity that is not a whole number', async () => {
    const loose = await newProduct();
    const box = await newProduct();
    const statuses = [];
    for (const quantity of [1.5, '10', 0] as any[]) {
      statuses.push(await statusOf(products.setLooseProductLink(box, loose, quantity, centro)));
    }

    assert({
      given: 'a box quantity that is a fraction, text or zero',
      should: 'refuse each with a 400 and leave the box unlinked',
      actual: [statuses, await looseAt(centro, box)],
      expected: [[400, 400, 400], null],
    });
  });

  test('a link at one store', async () => {
    const box = await newProduct();
    const centroLoose = await newProduct();
    const orienteLoose = await newProduct();
    await linkAt(oriente, box, orienteLoose);
    await products.setLooseProductLink(box, centroLoose, 10, centro);

    assert({
      given: 'a box linked at one store while another store has its own suelto for it',
      should: "link it at that store and leave the other store's suelto as it was",
      actual: [await looseAt(centro, box), await looseAt(oriente, box)],
      expected: [centroLoose, orienteLoose],
    });
  });

  test('unlinking at one store', async () => {
    const box = await newProduct();
    const loose = await newProduct();
    await linkAt(centro, box, loose);
    await linkAt(oriente, box, loose);
    await products.setLooseProductLink(box, null, undefined, centro);

    assert({
      given: 'a box linked at two stores, unlinked at one',
      should: 'remove only that store\'s link',
      actual: [await looseAt(centro, box), await looseAt(oriente, box)],
      expected: [null, loose],
    });
  });

  test('piezas por caja', async () => {
    const box = await newProduct({ quantity: 10 });
    await products.setLooseProductLink(box, await newProduct(), 20, centro);

    assert({
      given: 'a link that sets the pieces per box',
      should: 'set them on the box itself, the same at every store',
      actual: (await prisma.product.findUnique({ where: { id: box } }))?.quantity,
      expected: 20,
    });
  });

  test('a product not sold at the store', async () => {
    const box = await newProduct();
    const loose = await newProduct({ name: 'Paracetamol Suelto', soldOnlyAtLocationId: oriente });
    const error = await products.setLooseProductLink(box, loose, 10, centro).catch((e) => e);

    assert({
      given: 'a suelto sold only at another store',
      should: 'refuse with a 400 naming the product and the store, and link nothing',
      actual: [error.status, error.message, await looseAt(centro, box)],
      expected: [400, 'Paracetamol Suelto no se vende en Centro', null],
    });
  });

  test('a box not sold at the store', async () => {
    const box = await newProduct({ name: 'Paracetamol Caja', soldOnlyAtLocationId: oriente });
    const error = await products.setLooseProductLink(box, await newProduct(), 10, centro).catch((e) => e);

    assert({
      given: 'a box sold only at another store',
      should: 'refuse with a 400 naming the box and the store',
      actual: [error.status, error.message],
      expected: [400, 'Paracetamol Caja no se vende en Centro'],
    });
  });

  test('a link that loops back', async () => {
    const a = await newProduct();
    const b = await newProduct();
    const c = await newProduct();
    await linkAt(centro, b, a);
    await linkAt(centro, c, b);

    assert({
      given: "linking a product to a loose product whose own chain at this store leads back to it, directly (A↔B) or through another (A→C→B→A)",
      should: 'refuse both with a 400',
      actual: [await statusOf(products.setLooseProductLink(a, b, 10, centro)), await statusOf(products.setLooseProductLink(a, c, 10, centro))],
      expected: [400, 400],
    });
  });

  test("another store's chain", async () => {
    const a = await newProduct();
    const b = await newProduct();
    await linkAt(oriente, b, a);

    assert({
      given: 'a chain that leads back only through another store\'s links',
      should: 'link it, since only this store\'s links can loop its break-bulk',
      actual: await statusOf(products.setLooseProductLink(a, b, 10, centro)),
      expected: 200,
    });
  });

  test('a loop already in the data', async () => {
    const b = await newProduct();
    const c = await newProduct();
    await linkAt(centro, c, b);
    await linkAt(centro, b, c);
    const a = await newProduct();

    assert({
      given: 'linking a product to one already in a loop that does not include it (B→C→B)',
      should: 'answer instead of following the loop forever',
      actual: await statusOf(products.setLooseProductLink(a, b, 10, centro)),
      expected: 200,
    });
  });
});

describe('ProductsService product reads (Postgres)', () => {
  test("a box's suelto in the list and the product", async () => {
    const box = await newProduct({ name: `Caja-${Math.random()}` });
    const centroLoose = await newProduct();
    await prisma.productLooseLink.create({ data: { locationId: centro, boxProductId: box, looseProductId: centroLoose } });
    await prisma.productLooseLink.create({ data: { locationId: oriente, boxProductId: box, looseProductId: await newProduct() } });
    const listed = (at: string) => products.getProducts(at, { onlyIds: [box] }).then((r) => r.data.map((p) => p.looseProductId));

    assert({
      given: 'a box with a different suelto at each store',
      should: "give each store's list and product its own suelto, and no suelto without a store",
      actual: [await listed(centro), (await products.getProduct(box, centro)).data.looseProductId, (await products.getProduct(box)).data.looseProductId],
      expected: [[centroLoose], centroLoose, null],
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

describe('ProductsController.listLooseLinks (Postgres)', () => {
  test("a store's links", async () => {
    const { id: here } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Aquí' } });
    const { id: there } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Allá' } });
    const boxB = await newProduct({ name: `B caja ${Math.random()}` });
    const boxA = await newProduct({ name: `A caja ${Math.random()}` });
    const loose = await newProduct();
    const otherLoose = await newProduct();
    await prisma.productLooseLink.createMany({
      data: [
        { locationId: here, boxProductId: boxB, looseProductId: loose },
        { locationId: here, boxProductId: boxA, looseProductId: loose },
        { locationId: there, boxProductId: boxA, looseProductId: otherLoose },
      ],
    });
    const controller = new ProductsController(products, prisma, null as any, null as any, null as any);
    const req = { currentLocation: { locationId: here, role: 'MANAGER' } } as any;

    const { data } = await controller.listLooseLinks(req);

    assert({
      given: 'boxes linked at the session store and at another store',
      should: "list only this store's pairs by box name, as product rows with this store's suelto",
      actual: data.map((p: any) => [p.box.id, p.box.looseProductId, p.loose.id]),
      expected: [
        [boxA, loose, loose],
        [boxB, loose, loose],
      ],
    });
  });

  test('a link whose product is not sold at the store', async () => {
    const { id: here } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Aquí' } });
    const { id: there } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Allá' } });
    const box = await newProduct({ soldOnlyAtLocationId: there });
    const loose = await newProduct();
    // Linking refuses this and nothing changes where a product is sold; only a hand edit gets here.
    await prisma.productLooseLink.create({ data: { locationId: here, boxProductId: box, looseProductId: loose } });
    const controller = new ProductsController(products, prisma, null as any, null as any, null as any);
    const req = { currentLocation: { locationId: here, role: 'MANAGER' } } as any;

    const { data } = await controller.listLooseLinks(req);

    assert({
      given: 'a link at a store that does not sell its box',
      should: 'leave the pair out rather than send a pair missing a side',
      actual: data,
      expected: [],
    });
  });
});
