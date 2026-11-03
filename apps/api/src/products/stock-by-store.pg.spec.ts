/**
 * Every store's on-hand quantity of a product, against a real Postgres engine
 * (see testing/pglite.ts): what staff see when their own store is out.
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
  await prisma.location.create({ data: { squareId: 'SQ-CERRADA', name: 'Cerrada', isActive: false } });
}, 120_000);

afterAll(() => stop?.());

const batch = (productId: string, locationId: string, quantity: number) =>
  prisma.inventory.create({ data: { productId, locationId, quantity, unitCost: 10, receivedAt: new Date() } });

describe('ProductsService.getStockByStore', () => {
  test('a product sold everywhere', async () => {
    const product = await prisma.product.create({ data: { name: `Todas-${Math.random()}` } });
    await batch(product.id, norte, 3);
    await batch(product.id, norte, 4);

    assert({
      given: 'a product with two batches at Norte, none at Centro, and a closed store',
      should: 'list each open store with its summed quantity, 0 where it has none, and nothing about cost',
      actual: (await new ProductsService(prisma).getStockByStore(product.id)).data,
      expected: [
        { locationId: centro, locationName: 'Centro', quantity: 0 },
        { locationId: norte, locationName: 'Norte', quantity: 7 },
      ],
    });
  });

  test('a product sold only at one store', async () => {
    const product = await prisma.product.create({ data: { name: `Norte-${Math.random()}`, soldOnlyAtLocationId: norte } });
    await batch(product.id, norte, 2);

    assert({
      given: 'a product sold only at Norte',
      should: 'list only Norte',
      actual: (await new ProductsService(prisma).getStockByStore(product.id)).data,
      expected: [{ locationId: norte, locationName: 'Norte', quantity: 2 }],
    });
  });

  test('a Yastás service product', async () => {
    const product = await prisma.product.create({ data: { name: `Yastas-${Math.random()}`, tracksInventory: false } });

    assert({
      given: 'a product that does not track stock',
      should: 'list no stores, so the phone never says no store has it',
      actual: (await new ProductsService(prisma).getStockByStore(product.id)).data,
      expected: [],
    });
  });

  test('an unknown product', async () => {
    const status = await new ProductsService(prisma).getStockByStore('no-existe').then(() => 200, (e: any) => e.getStatus());

    assert({
      given: 'a product id that does not exist',
      should: 'refuse with a 404',
      actual: status,
      expected: 404,
    });
  });
});
