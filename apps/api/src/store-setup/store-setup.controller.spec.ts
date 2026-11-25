import { assert } from 'riteway/vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard, LocationGuard } from '../auth/guards/auth.guard';
import { StoreSetupController } from './store-setup.controller';
import { storeSetupChecklist } from './store-setup-checklist';

vi.mock('./store-setup-checklist', () => ({ storeSetupChecklist: vi.fn(async () => ({})) }));

const requestAt = (at?: string) => ({ employee: { id: 'emp-1' }, currentLocation: at && { locationId: at, role: 'OWNER', isActive: true } }) as never;
const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: { getStatus: () => number }) => e.getStatus());

describe('StoreSetupController', () => {
  test('who may read the checklist', () => {
    assert({
      given: 'the checklist route',
      should: 'be for owners only',
      actual: [Reflect.getMetadata(GUARDS_METADATA, StoreSetupController), Reflect.getMetadata('roles', StoreSetupController.prototype.checklist)],
      expected: [[AuthGuard, LocationGuard], ['OWNER']],
    });
  });

  test('which store', async () => {
    const controller = new StoreSetupController({} as never);
    assert({
      given: 'no store, another store, and no store with no session store',
      should: 'read the session\'s store, the one asked for, and refuse the last',
      actual: [
        await statusOf(controller.checklist(undefined, requestAt('centro'))),
        await statusOf(controller.checklist('norte', requestAt('centro'))),
        await statusOf(controller.checklist(undefined, requestAt())),
        vi.mocked(storeSetupChecklist).mock.calls.map((c) => c[1]),
      ],
      expected: [200, 200, 400, ['centro', 'norte']],
    });
  });
});
