import { assert } from 'riteway/vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard, LocationGuard } from '../auth/guards/auth.guard';
import { PurchaseNeedsController } from './purchase-needs.controller';
import { purchaseNeeds } from '../inventory/purchase-needs';

vi.mock('../inventory/purchase-needs', () => ({ purchaseNeeds: vi.fn(async () => ({ receivingLocationId: null, suppliesLocationIds: [], rows: [] })) }));

const requestAt = (role: string, at = 'centro') => ({ employee: { id: 'emp-1' }, currentLocation: { locationId: at, role, isActive: true } }) as never;
const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: { getStatus: () => number }) => e.getStatus());

describe('PurchaseNeedsController', () => {
  test('who may see a store\'s Por pedir', async () => {
    const controller = new PurchaseNeedsController({} as never);
    assert({
      given: 'the purchase-needs route',
      should: 'need a staff session at a store, as an owner or a manager',
      actual: [Reflect.getMetadata(GUARDS_METADATA, PurchaseNeedsController), Reflect.getMetadata('roles', PurchaseNeedsController.prototype.list)],
      expected: [[AuthGuard, LocationGuard], ['OWNER', 'MANAGER']],
    });
    assert({
      given: 'a manager asking for their store, for another, and an owner for any',
      should: 'answer only for the manager\'s own store, and the owner anywhere',
      actual: [
        await statusOf(controller.list(undefined, requestAt('MANAGER'))),
        await statusOf(controller.list('norte', requestAt('MANAGER'))),
        await statusOf(controller.list('norte', requestAt('OWNER'))),
        vi.mocked(purchaseNeeds).mock.calls.map((c) => c[1]),
      ],
      expected: [200, 403, 200, ['centro', 'norte']],
    });
  });
});
