import { assert } from 'riteway/vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { WorkerSecretGuard } from '../auth/guards/worker-secret.guard';
import { InternalBreakBulkController } from './internal-break-bulk.controller';

const body = { locationId: 'centro', looseProductId: 'p1', needed: 3, requestKey: 'pay1:p1' };

describe('InternalBreakBulkController', () => {
  test('who may call it', () => {
    assert({
      given: 'the internal cover route',
      should: 'be guarded by the worker secret alone, not a staff session',
      actual: Reflect.getMetadata(GUARDS_METADATA, InternalBreakBulkController),
      expected: [WorkerSecretGuard],
    });
  });

  test('a cover request from the worker', async () => {
    const breakBulk = { coverLoose: vi.fn().mockResolvedValue({ boxesOpened: 1 }) };

    const result = await new InternalBreakBulkController(breakBulk as any).cover(body);

    assert({
      given: 'a well-formed cover request',
      should: 'cover the sueltos and tell Square, returning what was opened',
      actual: [breakBulk.coverLoose.mock.calls[0][0], result],
      expected: [{ ...body, syncToSquare: true }, { success: true, data: { boxesOpened: 1 } }],
    });
  });

  test('a malformed cover request', async () => {
    const breakBulk = { coverLoose: vi.fn() };
    const controller = new InternalBreakBulkController(breakBulk as any);
    const status = (b: any) => controller.cover(b).then(() => 'covered', (e: any) => e.getStatus());

    assert({
      given: 'a missing store, a fractional or zero need, and no request key',
      should: 'refuse each with 400 and cover nothing',
      actual: [
        await status({ ...body, locationId: undefined }),
        await status({ ...body, needed: 1.5 }),
        await status({ ...body, needed: 0 }),
        await status({ ...body, requestKey: '' }),
        breakBulk.coverLoose.mock.calls.length,
      ],
      expected: [400, 400, 400, 400, 0],
    });
  });
});

describe('BreakBulkController.automatic', () => {
  test('who may see automatic openings', async () => {
    const { BreakBulkController } = await import('./break-bulk.controller');
    const { ROLES_KEY } = await import('../auth/guards/auth.guard');

    assert({
      given: 'the list of boxes opened by sales',
      should: 'be for the owner and managers, not cashiers',
      actual: Reflect.getMetadata(ROLES_KEY, BreakBulkController.prototype.automatic),
      expected: ['OWNER', 'MANAGER'],
    });
  });
});
