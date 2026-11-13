/**
 * POST /transfers/stock against a real Postgres engine: the numbers the
 * Transferencias list refreshes must match what the product screen shows.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { TransferService } from './transfer.service';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

describe('TransferService.stockAt', () => {
  test('a stocked product, one at 0 and an unknown id', async () => {
    const { id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } });
    const { id: norte } = await prisma.location.create({ data: { squareId: 'SQ-NORTE', name: 'Norte' } });
    const stocked = await prisma.product.create({ data: { name: 'Paracetamol' } });
    const empty = await prisma.product.create({ data: { name: 'Ibuprofeno' } });
    await prisma.inventory.createMany({
      data: [
        { productId: stocked.id, locationId: centro, quantity: 7, unitCost: 2, receivedAt: new Date('2026-10-01') },
        { productId: stocked.id, locationId: centro, quantity: 3, unitCost: 3, receivedAt: new Date('2026-10-05') },
        { productId: stocked.id, locationId: norte, quantity: 40, unitCost: 2, receivedAt: new Date('2026-10-01') },
        { productId: empty.id, locationId: norte, quantity: 5, unitCost: 2, receivedAt: new Date('2026-10-01') },
      ],
    });
    const products = new ProductsService(prisma);
    const onProductScreen = async (id: string) => (await products.getProduct(id, centro)).data.totalInventory;

    const stock = await new TransferService(prisma, {} as any).stockAt(centro, [stocked.id, empty.id, 'no-such-product']);

    assert({
      given: "Centro's stock for a product with two lots there, one with lots only at Norte, and an unknown id",
      should: "answer Centro's lots only, matching the product screen, and leave the unknown id out",
      actual: stock,
      expected: { [stocked.id]: await onProductScreen(stocked.id), [empty.id]: await onProductScreen(empty.id) },
    });
    assert({
      given: 'the same request',
      should: 'count 10 and 0',
      actual: [stock[stocked.id], stock[empty.id]],
      expected: [10, 0],
    });
  });
});
