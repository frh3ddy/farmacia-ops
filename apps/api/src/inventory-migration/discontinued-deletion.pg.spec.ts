/**
 * Deleting a discontinued product at cutover, against a real Postgres engine,
 * so the foreign keys that protect a product's history are enforced.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from '../inventory/inventory-adjustment.service';
import { InventoryMigrationService } from './inventory-migration.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let locationId: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: locationId } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  await prisma.cutoverLock.create({ data: { locationId, cutoverDate: new Date('2026-09-01') } });
}, 120_000);

afterAll(() => stop?.());

/** The service with Square's catalog delete recorded instead of sent. */
function migrationService() {
  const deleteCatalogItem = vi.fn().mockResolvedValue(undefined);
  const products = { deleteCatalogItem };
  const service = new InventoryMigrationService(prisma, {} as any, {} as any, {} as any, {} as any, products as any);
  const finalize = (productId: string) => service['finalizeDiscontinuedProductDeletion'](productId, `sq-${productId}`);
  return { finalize, deleteCatalogItem };
}

const discontinuedProduct = () =>
  prisma.product.create({ data: { name: `P-${Math.random()}`, isDiscontinued: true } });

describe('finalizeDiscontinuedProductDeletion', () => {
  test('a product with stock history at a location already cut over', async () => {
    const product = await discontinuedProduct();
    const adjustments = new InventoryAdjustmentService(prisma);
    await adjustments.createAdjustment({ locationId, productId: product.id, type: 'FOUND', quantity: 5, unitCost: 2 });
    await adjustments.createAdjustment({ locationId, productId: product.id, type: 'DAMAGE', quantity: -2 });
    const { finalize, deleteCatalogItem } = migrationService();

    await finalize(product.id);

    assert({
      given: 'a discontinued product with batches, adjustments and consumption history',
      should: 'retire it in Square',
      actual: deleteCatalogItem.mock.calls.length,
      expected: 1,
    });
    assert({
      given: 'its history',
      should: 'keep the product, still discontinued, with its stock and history intact',
      actual: [
        (await prisma.product.findUnique({ where: { id: product.id } }))?.isDiscontinued,
        await prisma.inventory.count({ where: { productId: product.id } }),
        await prisma.inventoryAdjustment.count({ where: { productId: product.id } }),
      ],
      expected: [true, 1, 2],
    });
  });

  test('a product with no history', async () => {
    const product = await discontinuedProduct();
    await prisma.catalogMapping.create({ data: { productId: product.id, squareVariationId: `v-${product.id}` } });
    const { finalize } = migrationService();

    await finalize(product.id);

    assert({
      given: 'a discontinued product that never had stock, sales or movements',
      should: 'delete it locally too',
      actual: await prisma.product.findUnique({ where: { id: product.id } }),
      expected: null,
    });
  });
});
