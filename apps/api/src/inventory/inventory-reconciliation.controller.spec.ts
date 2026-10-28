import { PATH_METADATA } from '@nestjs/common/constants';
import { assert } from 'riteway/vitest';
import { InventoryReconciliationController } from './inventory-reconciliation.controller';

const routePaths = () =>
  Object.getOwnPropertyNames(InventoryReconciliationController.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => (InventoryReconciliationController.prototype as any)[name])
    .filter((handler) => typeof handler === 'function' && Reflect.getMetadata(PATH_METADATA, handler) !== undefined)
    .map((handler) => Reflect.getMetadata(PATH_METADATA, handler))
    .sort();

describe('InventoryReconciliationController routes', () => {
  test('reconciliation report', () => {
    // Regression: product/:productId and location/:locationId set expected =
    // current, so every product read "reconciled". The nightly integrity check
    // replaces them (tasks/inventory-integrity-epic.md).
    assert({
      given: 'the reconciliation controller',
      should: 'serve only the consumption lookups (FIFO is checked nightly by the worker)',
      actual: routePaths(),
      expected: ['consumption/:productId', 'sale-item/:saleItemId'],
    });
  });
});

describe('InventoryReconciliationController.getSaleItemConsumption', () => {
  test("a sale item's FIFO trail", async () => {
    const managerRequest = {
      currentLocation: { role: 'MANAGER', locationId: 'centro' },
      accessibleLocations: [{ locationId: 'centro', isActive: true }],
    } as any; // fixture: only the fields the controller reads
    const consumption = (batchLocationId: string) => ({
      batchLocationId,
      unitCost: { toString: () => '2' },
      totalCost: { toString: () => '2' },
      batchReceivedAt: new Date('2026-10-01'),
      consumedAt: new Date('2026-10-02'),
      quantityConsumed: 1,
    });
    const outcomeAt = (locationId: string) => {
      const service = { getSaleItemConsumption: vi.fn().mockResolvedValue([consumption(locationId)]) };
      return new InventoryReconciliationController(service as any)
        .getSaleItemConsumption('si1', managerRequest)
        .then(() => 'done', (e: any) => e.response?.message ?? e.message);
    };

    assert({
      given: "a manager of Centro opening a Norte sale item's batches, then a Centro one's",
      should: "refuse Norte's and show Centro's",
      actual: [await outcomeAt('norte'), await outcomeAt('centro')],
      expected: ['No tienes acceso a esta sucursal', 'done'],
    });
  });
});
