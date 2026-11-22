import { assert } from 'riteway/vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard, LocationGuard } from '../auth/guards/auth.guard';
import { StockAlertSettingsController } from './stock-alert-settings.controller';
import { stockAlertSettingsOf, updateStockAlertSettings } from './stock-alert-settings';

vi.mock('./stock-alert-settings', () => ({ stockAlertSettingsOf: vi.fn(async () => ({})), updateStockAlertSettings: vi.fn(async () => ({})) }));

const requestAt = (role: string, at = 'centro') => ({ employee: { id: 'emp-1' }, currentLocation: { locationId: at, role, isActive: true } }) as never;
const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: { getStatus: () => number }) => e.getStatus());

describe('StockAlertSettingsController', () => {
  test('who may read and change settings', async () => {
    const controller = new StockAlertSettingsController({} as never);
    assert({
      given: 'the settings routes',
      should: 'let owners and managers read, and only owners change',
      actual: [
        Reflect.getMetadata(GUARDS_METADATA, StockAlertSettingsController),
        Reflect.getMetadata('roles', StockAlertSettingsController.prototype.get),
        Reflect.getMetadata('roles', StockAlertSettingsController.prototype.update),
      ],
      expected: [[AuthGuard, LocationGuard], ['OWNER', 'MANAGER'], ['OWNER']],
    });
    assert({
      given: 'a manager reading their store, another store, and an owner reading any',
      should: 'answer only for the manager\'s own store, and the owner anywhere',
      actual: [
        await statusOf(controller.get(undefined, requestAt('MANAGER'))),
        await statusOf(controller.get('norte', requestAt('MANAGER'))),
        await statusOf(controller.get('norte', requestAt('OWNER'))),
        vi.mocked(stockAlertSettingsOf).mock.calls.map((c) => c[1]),
      ],
      expected: [200, 403, 200, ['centro', 'norte']],
    });
  });

  test('a change', async () => {
    const controller = new StockAlertSettingsController({} as never);
    await controller.update({ locationId: 'norte', coverDays: 21 }, requestAt('OWNER'));
    assert({
      given: 'an owner changing another store\'s days of cover',
      should: 'change that store\'s settings',
      actual: vi.mocked(updateStockAlertSettings).mock.calls[0].slice(1) as unknown[],
      expected: ['norte', { locationId: 'norte', coverDays: 21 }],
    });
  });
});
