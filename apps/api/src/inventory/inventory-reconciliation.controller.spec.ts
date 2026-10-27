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
      should: 'serve only the FIFO checks, not the always-reconciled report',
      actual: routePaths(),
      expected: ['consumption/:productId', 'sale-item/:saleItemId', 'verify-fifo/:saleId'],
    });
  });
});
