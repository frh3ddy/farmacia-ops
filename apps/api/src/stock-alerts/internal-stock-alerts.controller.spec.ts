import { assert } from 'riteway/vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { WorkerSecretGuard } from '../auth/guards/worker-secret.guard';
import { InternalStockAlertsController } from './internal-stock-alerts.controller';
import { recordStockDays } from './stock-days';

vi.mock('./stock-days', () => ({ recordStockDays: vi.fn().mockResolvedValue(42) }));

describe('InternalStockAlertsController', () => {
  test('who may call it', () => {
    assert({
      given: 'the nightly stock route',
      should: 'be guarded by the worker secret alone, not a staff session',
      actual: Reflect.getMetadata(GUARDS_METADATA, InternalStockAlertsController),
      expected: [WorkerSecretGuard],
    });
  });

  test('the nightly run', async () => {
    const prisma = {};
    const result = await new InternalStockAlertsController(prisma as never).stockDays();

    assert({
      given: 'the worker\'s nightly call',
      should: 'store the missing stock days and say how many rows it wrote',
      actual: [vi.mocked(recordStockDays).mock.calls[0][0], result],
      expected: [prisma, { success: true, data: { saved: 42 } }],
    });
  });
});
