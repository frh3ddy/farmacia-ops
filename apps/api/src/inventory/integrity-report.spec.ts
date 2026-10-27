import { assert } from 'riteway/vitest';
import { ROLES_KEY } from '../auth/guards/auth.guard';
import { InventoryReportsController } from './inventory-reports.controller';
import { InventoryReportsService } from './inventory-reports.service';

describe('integrity report', () => {
  test('who can read it', () => {
    assert({
      given: 'the latest nightly integrity run',
      should: 'be readable by owners only',
      actual: Reflect.getMetadata(ROLES_KEY, InventoryReportsController.prototype.getLatestIntegrityRun),
      expected: ['OWNER'],
    });
  });

  test('latest run', async () => {
    const run = { id: 'r2', ranAt: new Date('2026-10-27T09:00:00Z'), mismatchCount: 1, checks: {} };
    const prisma = { integrityRun: { findFirst: vi.fn().mockResolvedValue(run) } };
    const controller = new InventoryReportsController(new InventoryReportsService(prisma as any));

    assert({
      given: 'stored integrity runs',
      should: 'answer with the most recent one',
      actual: { body: await controller.getLatestIntegrityRun(), query: prisma.integrityRun.findFirst.mock.calls[0][0] },
      expected: { body: { success: true, data: run }, query: { orderBy: { ranAt: 'desc' } } },
    });
  });

  test('no run yet', async () => {
    const prisma = { integrityRun: { findFirst: vi.fn().mockResolvedValue(null) } };
    const controller = new InventoryReportsController(new InventoryReportsService(prisma as any));

    assert({
      given: 'no integrity run stored yet',
      should: 'answer with null so the web app can say the check has not run',
      actual: await controller.getLatestIntegrityRun(),
      expected: { success: true, data: null },
    });
  });
});
