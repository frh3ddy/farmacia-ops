import { assert } from 'riteway/vitest';
import { ROLES_KEY } from '../auth/guards/auth.guard';
import { ProductsController } from './products.controller';

/** A product as the service returns it: stock batches, recent receivings and their costs. */
const product = () => ({
  id: 'p1',
  name: 'Paracetamol',
  sellingPrice: 30,
  totalInventory: 5,
  averageCost: 12.5,
  inventories: [{ id: 'b1', quantity: 5, unitCost: 12.5, costSource: 'MANUAL_INPUT', receivedAt: '2026-10-01' }],
  receivings: [{ id: 'r1', quantity: 5, unitCost: 12.5, totalCost: 62.5, invoiceNumber: 'F-1', receivedAt: '2026-10-01' }],
});

/** The controller over a recorded service, for an employee at Centro with `role`. */
function productRoutesAs(role: string) {
  const service = {
    getProduct: vi.fn(async () => ({ success: true, data: product() })),
    getProducts: vi.fn(async () => ({ success: true, data: [product()], count: 1 })),
  };
  const controller = new ProductsController(service as any, {} as any, {} as any, {} as any);
  const req = { currentLocation: { locationId: 'centro', role } } as any;
  return {
    detail: async (): Promise<unknown> => (await controller.getProduct('p1', '', req)).data,
    list: async (): Promise<unknown> => (await controller.getProducts('', '', '', '', '', req)).data[0],
  };
}

describe('ProductsController product costs', () => {
  test('a cashier', async () => {
    const { detail, list } = productRoutesAs('CASHIER');
    const shown = [await detail(), await list()];

    assert({
      given: 'a cashier reading a product and the product list',
      should: 'show stock and selling price but no average cost, batch cost or receiving cost',
      actual: shown,
      expected: [
        {
          id: 'p1',
          name: 'Paracetamol',
          sellingPrice: 30,
          totalInventory: 5,
          inventories: [{ id: 'b1', quantity: 5, receivedAt: '2026-10-01' }],
          receivings: [{ id: 'r1', quantity: 5, invoiceNumber: 'F-1', receivedAt: '2026-10-01' }],
        },
        {
          id: 'p1',
          name: 'Paracetamol',
          sellingPrice: 30,
          totalInventory: 5,
          inventories: [{ id: 'b1', quantity: 5, receivedAt: '2026-10-01' }],
          receivings: [{ id: 'r1', quantity: 5, invoiceNumber: 'F-1', receivedAt: '2026-10-01' }],
        },
      ],
    });
  });

  test('every other role', async () => {
    const shown = [];
    for (const role of ['OWNER', 'MANAGER', 'ACCOUNTANT']) {
      shown.push(await productRoutesAs(role).detail());
    }

    assert({
      given: 'an owner, a manager and an accountant reading a product',
      should: 'show its costs as today',
      actual: shown,
      expected: [product(), product(), product()],
    });
  });

  test('supplier costs and cost history', () => {
    const roles = ['getProductSuppliers', 'getProductCostHistory'].map((name) =>
      Reflect.getMetadata(ROLES_KEY, (ProductsController.prototype as any)[name]),
    );

    assert({
      given: "a product's supplier costs and cost history",
      should: 'be closed to cashiers',
      actual: roles,
      expected: [['OWNER', 'MANAGER', 'ACCOUNTANT'], ['OWNER', 'MANAGER', 'ACCOUNTANT']],
    });
  });
});
