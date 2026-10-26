import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard, ROLES_KEY } from './auth.guard';
import { CatalogController } from '../../catalog/catalog.controller';
import { InventoryAgingController } from '../../inventory-aging/inventory-aging.controller';
import { DataController } from '../../data/data.controller';

// Regression: these were reachable without a session — anyone could read
// inventory cost/aging or trigger a Square catalog sync.
describe('route guards', () => {
  it.each([
    [CatalogController, ['OWNER', 'MANAGER']],
    [InventoryAgingController, ['OWNER', 'MANAGER', 'ACCOUNTANT']],
  ])('%p requires a session and a role', (controller, roles) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(AuthGuard);
    expect(Reflect.getMetadata(ROLES_KEY, controller)).toEqual(roles);
  });

  it('limits test inventory seeding to owners', () => {
    expect(Reflect.getMetadata(ROLES_KEY, DataController.prototype.createTestInventory)).toEqual(['OWNER']);
  });
});
