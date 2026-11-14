import { assert } from 'riteway/vitest';
import { ROLES_KEY } from '../auth/guards/auth.guard';
import { ProductsController } from './products.controller';

/** A product as the service returns it, with its costs. */
const product = () => ({ id: 'p1', averageCost: 12.5, inventories: [{ id: 'b1', quantity: 5, unitCost: 12.5 }], receivings: [] });

/**
 * The controller over a recorded service, for an employee now at Centro as a
 * manager who is a cashier at Norte.
 */
function routesForManagerAtCentroCashierAtNorte() {
  const service = {
    createProduct: vi.fn().mockResolvedValue({ message: 'ok' }),
    syncUnsyncedProducts: vi.fn().mockResolvedValue({ synced: 0, total: 0, failed: 0 }),
    getProduct: vi.fn(async () => ({ success: true, data: product() })),
    getProducts: vi.fn(async () => ({ success: true, data: [product()] })),
    getProductCounts: vi.fn(async () => ({
      success: true,
      data: { total: 10, outOfStock: 1, lowStock: 2, lowMargin: 3, synced: 9, local: 1 },
    })),
  };
  const controller = new ProductsController(service as any, {} as any, {} as any, {} as any, {} as any);
  const centro = { locationId: 'centro', role: 'MANAGER', isActive: true };
  const norte = { locationId: 'norte', role: 'CASHIER', isActive: true };
  const req = { currentLocation: centro, accessibleLocations: [centro, norte] } as any;
  const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: any) => e.getStatus());
  return { service, controller, req, statusOf };
}

describe('ProductsController at another store', () => {
  test('creating and syncing there', async () => {
    const { service, controller, req, statusOf } = routesForManagerAtCentroCashierAtNorte();
    const statuses = [
      await statusOf(controller.createProduct({ name: 'Gel', sellingPrice: 30, locationId: 'norte' } as any, req)),
      await statusOf(controller.syncToSquare({ locationId: 'norte' }, req)),
    ];

    assert({
      given: 'a manager at Centro creating a product and running sync to Square for Norte',
      should: 'refuse both with a 403 and call nothing',
      actual: [statuses, service.createProduct.mock.calls.length, service.syncUnsyncedProducts.mock.calls.length],
      expected: [[403, 403], 0, 0],
    });
  });

  test('reading costs there', async () => {
    const { controller, req } = routesForManagerAtCentroCashierAtNorte();
    const atNorte = (await controller.getProduct('p1', 'norte', req)).data as any;
    const listAtNorte = (await controller.getProducts('norte', '', '', '', '', req)).data[0] as any;
    const atCentro = (await controller.getProduct('p1', 'centro', req)).data as any;

    assert({
      given: 'a manager at Centro who is a cashier at Norte reading a product for each store',
      should: 'hide costs for Norte, where they are a cashier, and show them for Centro',
      actual: [atNorte.averageCost, listAtNorte.averageCost, atCentro.averageCost],
      expected: [undefined, undefined, 12.5],
    });
  });

  test('reading product counts there', async () => {
    const { controller, req } = routesForManagerAtCentroCashierAtNorte();
    const atNorte = (await controller.getProductCounts('norte', req)).data as any;
    const atCentro = (await controller.getProductCounts('centro', req)).data as any;

    assert({
      given: 'a manager at Centro who is a cashier at Norte reading product counts for each store',
      should: 'leave out the low-margin count (it comes from cost) for Norte and keep it for Centro',
      actual: [atNorte.lowMargin, atNorte.total, atCentro.lowMargin],
      expected: [undefined, 10, 3],
    });
  });
});

describe("ProductsController.getStockByStore", () => {
  test("every store's stock", async () => {
    const { service, controller } = routesForManagerAtCentroCashierAtNorte();
    const stock = [{ locationId: 'norte', locationName: 'Norte', quantity: 4 }];
    (service as any).getStockByStore = vi.fn(async () => ({ success: true, data: stock }));

    assert({
      given: "a cashier asking for a product's stock at every store",
      should: 'be open to every role and return the stores the service gives',
      actual: [
        Reflect.getMetadata(ROLES_KEY, ProductsController.prototype.getStockByStore),
        (await controller.getStockByStore('p1')).data,
      ],
      expected: [['OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER'], stock],
    });
  });
});

describe('ProductsController loose link at a chosen store', () => {
  test('linking a box with its suelto', async () => {
    const { service, controller, req, statusOf } = routesForManagerAtCentroCashierAtNorte();
    const link = vi.fn(async () => ({ id: 'p1' }));
    Object.assign(service, { setLooseProductLink: link });
    const owner = { ...req, currentLocation: { locationId: 'centro', role: 'OWNER', isActive: true } };
    const refused = await statusOf(controller.setLooseProductLink('p1', { looseProductId: 'p2', locationId: 'norte' }, req));
    await controller.setLooseProductLink('p1', { looseProductId: 'p2' }, req);
    await controller.setLooseProductLink('p1', { looseProductId: 'p2', quantity: 20, locationId: 'norte' }, owner);

    assert({
      given: 'a manager at Centro linking at Norte, then without a store, and an owner at Centro linking at Norte',
      should: 'refuse the manager at Norte with 403, link the manager at Centro, and link the owner at Norte',
      actual: [refused, link.mock.calls],
      expected: [403, [['p1', 'p2', undefined, 'centro'], ['p1', 'p2', 20, 'norte']]],
    });
  });
});
