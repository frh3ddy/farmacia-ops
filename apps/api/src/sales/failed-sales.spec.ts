import { GUARDS_METADATA } from '@nestjs/common/constants';
import { assert } from 'riteway/vitest';
import { FailedSalesController } from './failed-sales.controller';
import { ROLES_KEY } from '../auth/guards/auth.guard';

const saleJob = {
  id: 'evt-1',
  name: 'process-sale',
  data: { payload: { object: { payment: { id: 'pay-1', card_details: { last_4: '1234' } } } } },
  failedReason: 'Sale validation error: Oriente has not finished its cutover; replay this sale once it has',
  finishedOn: Date.parse('2026-11-01T15:00:00Z'),
};
const refundJob = { id: 'evt-2', name: 'square-refund', data: { payload: { object: { refund: { id: 'rf-1' } } } }, failedReason: 'Order not found', finishedOn: undefined };

describe('FailedSalesController', () => {
  test('who may see and replay failed sales', () => {
    const roles = (method: 'list' | 'replay') => Reflect.getMetadata(ROLES_KEY, FailedSalesController.prototype[method]);
    assert({
      given: 'the failed-sales routes',
      should: 'be for owners only, behind the auth and location guards',
      actual: [roles('list'), roles('replay'), (Reflect.getMetadata(GUARDS_METADATA, FailedSalesController) ?? []).map((g: Function) => g.name)],
      expected: [['OWNER'], ['OWNER'], ['AuthGuard', 'LocationGuard']],
    });
  });

  test('the failed sales', async () => {
    const controller = new FailedSalesController({ failedJobs: async (name: string) => (name === 'process-sale' ? [saleJob] : [refundJob]) } as any);

    assert({
      given: 'a failed Square sale and a failed Square refund',
      should: 'list each with its payment or refund id and why it failed, never the rest of the job data',
      actual: await controller.list(),
      expected: {
        success: true,
        data: [
          { jobId: 'evt-1', squareId: 'pay-1', error: 'Oriente has not finished its cutover; replay this sale once it has', failedAt: new Date('2026-11-01T15:00:00Z') },
          { jobId: 'evt-2', squareId: 'rf-1', error: 'Order not found', failedAt: null },
        ],
        count: 2,
      },
    });
  });

  test('replaying them', async () => {
    const controller = new FailedSalesController({ replayFailedSales: async () => 2 } as any);

    assert({
      given: 'two failed sales replayed',
      should: 'say how many went back to the worker',
      actual: await controller.replay(),
      expected: { success: true, data: { replayed: 2 } },
    });
  });
});
