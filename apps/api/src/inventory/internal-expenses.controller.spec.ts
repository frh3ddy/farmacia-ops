import { assert } from 'riteway/vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { WorkerSecretGuard } from '../auth/guards/worker-secret.guard';
import { InternalExpensesController } from './internal-expenses.controller';

describe('InternalExpensesController', () => {
  test('who may call it', () => {
    assert({
      given: 'the internal auto-pay route',
      should: 'be guarded by the worker secret alone, not a staff session',
      actual: Reflect.getMetadata(GUARDS_METADATA, InternalExpensesController),
      expected: [WorkerSecretGuard],
    });
  });

  test('the daily auto-pay run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-01T05:30:00Z')); // still Nov 30 at the store
    const recurring = { autoPay: vi.fn().mockResolvedValue({ paid: ['r:2026-11-30'], failed: [] }) };

    const result = await new InternalExpensesController(recurring as any).autoPay();
    vi.useRealTimers();

    assert({
      given: 'a run just after midnight UTC',
      should: "book the bills due up to the store's today and return what was booked",
      actual: [recurring.autoPay.mock.calls[0], result],
      expected: [['2026-11-30'], { success: true, data: { paid: ['r:2026-11-30'], failed: [] } }],
    });
  });
});
