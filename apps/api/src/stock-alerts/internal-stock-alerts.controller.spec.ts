import { assert } from 'riteway/vitest';
import { Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { WorkerSecretGuard } from '../auth/guards/worker-secret.guard';
import { InternalStockAlertsController } from './internal-stock-alerts.controller';
import { recordStockDays } from './stock-days';
import { recordStockStats } from './stock-stats';

const order: string[] = [];
vi.mock('./stock-days', () => ({ recordStockDays: vi.fn(async () => (order.push('days'), 42)) }));
vi.mock('./stock-stats', () => ({ recordStockStats: vi.fn(async () => (order.push('stats'), 7)) }));

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
      should: 'store the missing stock days, then the stats from them, and say how many rows each wrote',
      actual: [vi.mocked(recordStockDays).mock.calls[0][0], vi.mocked(recordStockStats).mock.calls[0][0], order, result],
      expected: [prisma, prisma, ['days', 'stats'], { success: true, data: { saved: 42, stats: 7 } }],
    });
  });

  test('how long each half took', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await new InternalStockAlertsController({} as never).stockDays();
    const lines = log.mock.calls.map(([message]) => String(message));
    log.mockRestore();

    assert({
      given: 'the nightly run',
      should: 'log the rows and the milliseconds of the stock days and of the stats, each on its own',
      actual: lines.map((l) => l.replace(/\d+ ms/, 'N ms')),
      expected: ['Stock days: 42 rows in N ms', 'Stock stats: 7 rows in N ms'],
    });
  });
});
