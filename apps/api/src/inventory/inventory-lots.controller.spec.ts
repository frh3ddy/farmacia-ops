import { assert } from 'riteway/vitest';
import { ROLES_KEY } from '../auth/guards/auth.guard';
import { InventoryLotsController } from './inventory-lots.controller';

describe('InventoryLotsController', () => {
  const lotsFor = vi.fn(async () => [{ quantity: 4, expiryDate: '2027-01-01', batchNumber: null }]);
  const controller = new InventoryLotsController({ lots: lotsFor } as any);
  const manager = { employee: { id: 'e1' }, currentLocation: { role: 'MANAGER', locationId: 'centro' } } as any;

  test("a product's lots", async () => {
    const lots = (await controller.lots('p1', undefined, manager)).data;

    assert({
      given: 'a manager asking for a product with no store named',
      should: "read the session's store, open to owners and managers",
      actual: [lotsFor.mock.calls[0], lots.length, Reflect.getMetadata(ROLES_KEY, InventoryLotsController.prototype.lots)],
      expected: [['p1', 'centro'], 1, ['OWNER', 'MANAGER']],
    });
  });

  test('another store', async () => {
    assert({
      given: "a Centro manager asking for Norte's lots",
      should: 'refuse it',
      actual: await controller.lots('p1', 'norte', manager).then(() => 'done', (e: Error) => e.message),
      expected: 'Solo el dueño puede hacer esto en otras sucursales',
    });
  });
});
