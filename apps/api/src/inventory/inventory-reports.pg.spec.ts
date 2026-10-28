/**
 * Loss reports against a real Postgres engine (see testing/pglite.ts): which
 * adjustments count as shrinkage.
 */
import { assert } from 'riteway/vitest';
import { AdjustmentType } from '@prisma/client';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryReportsService } from './inventory-reports.service';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

/** A location whose only adjustments are the given [type, quantity] pairs, each at $10/unit. */
async function locationWith(adjustments: [AdjustmentType, number][]) {
  const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Centro' } });
  const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
  await prisma.inventoryAdjustment.createMany({
    data: adjustments.map(([type, quantity]) => ({ locationId, productId, type, quantity, unitCost: 10, totalCost: Math.abs(quantity) * 10 })),
  });
  return locationId;
}

describe('InventoryReportsService shrinkage', () => {
  test('stock that moved, next to stock that was lost', async () => {
    const reports = new InventoryReportsService(prisma);
    const locationId = await locationWith([
      ['DAMAGE', -1],
      ['TRANSFER_OUT', -5],
      ['BREAK_BULK_OUT', -2],
      ['BREAK_BULK_IN', 40],
      ['FOUND', 3],
    ]);

    const [pnl, impact] = await Promise.all([
      reports.getProfitAndLossReport({ locationId }),
      reports.getAdjustmentImpactReport({ locationId }),
    ]);

    assert({
      given: 'a damaged unit, a transfer out and a box broken into loose units',
      should: 'count only the damage as shrinkage in the P&L',
      actual: pnl.operatingExpenses.shrinkage,
      expected: '10',
    });
    assert({
      given: 'the same adjustments',
      should: 'leave transfers and break-bulk out of the loss and gain report',
      actual: [impact.summary.totalAdjustments, impact.summary.totalLoss, impact.summary.totalGain],
      expected: [2, '10', '30'],
    });
  });
});
