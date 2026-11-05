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
      ['RETURN', 3],
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

  test('a miscount fixed later, next to stock that was not recovered', async () => {
    const reports = new InventoryReportsService(prisma);
    const locationId = await locationWith([
      ['COUNT_CORRECTION', -5],
      ['COUNT_CORRECTION', 5],
      ['THEFT', -2],
      ['FOUND', 1],
      ['RETURN', 4],
      ['AUTO_SALE_COVER', 6],
    ]);

    const pnl = await reports.getProfitAndLossReport({ locationId });

    assert({
      given: 'a recount down 5 then up 5, 2 stolen and 1 found, plus a customer return and a sale cover',
      should: 'net found and recounted-up stock against losses, leaving returns and sale covers out',
      actual: pnl.operatingExpenses.shrinkage,
      expected: '10',
    });
    assert({
      given: 'the same adjustments',
      should: 'report losses and recoveries separately so screens never show a negative merma',
      actual: [pnl.operatingExpenses.shrinkageLosses, pnl.operatingExpenses.shrinkageRecovered],
      expected: ['70', '60'],
    });
  });
});

describe('InventoryReportsService opening count', () => {
  test('migration stock fixed by a Conteo inicial, next to a real loss', async () => {
    const reports = new InventoryReportsService(prisma);
    const locationId = await locationWith([
      ['OPENING_COUNT', -6],
      ['OPENING_COUNT', 2],
      ['DAMAGE', -1],
    ]);

    const [pnl, impact] = await Promise.all([
      reports.getProfitAndLossReport({ locationId }),
      reports.getAdjustmentImpactReport({ locationId }),
    ]);

    assert({
      given: 'a Conteo inicial down 6 and up 2, and one damaged unit',
      should: 'count only the damage as shrinkage',
      actual: [pnl.operatingExpenses.shrinkageLosses, pnl.operatingExpenses.shrinkageRecovered],
      expected: ['10', '0'],
    });
    assert({
      given: 'the same adjustments',
      should: 'leave the Conteo inicial out of the loss and gain report',
      actual: [impact.summary.totalAdjustments, impact.summary.totalLoss, impact.summary.totalGain],
      expected: [1, '10', '0'],
    });
  });
});

describe('InventoryReportsService backdated adjustments', () => {
  test('damage entered in October for a September date', async () => {
    const reports = new InventoryReportsService(prisma);
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Centro' } });
    const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
    await prisma.inventoryAdjustment.create({
      data: {
        locationId, productId, type: 'DAMAGE', quantity: -1, unitCost: 10, totalCost: 10,
        effectiveDate: new Date('2026-09-15T18:00:00Z'), adjustedAt: new Date('2026-10-02T18:00:00Z'),
      },
    });
    const september = { locationId, startDate: new Date('2026-09-01T06:00:00Z'), endDate: new Date('2026-10-01T05:59:59.999Z') };
    const october = { locationId, startDate: new Date('2026-10-01T06:00:00Z'), endDate: new Date('2026-11-01T05:59:59.999Z') };

    const shrinkage = async (period: typeof september) => [
      (await reports.getProfitAndLossReport(period)).operatingExpenses.shrinkage,
      (await reports.getAdjustmentImpactReport(period)).summary.totalAdjustments,
    ];

    assert({
      given: 'a damaged unit dated Sep 15 but entered on Oct 2',
      should: "count in September's P&L and loss report, not October's",
      actual: [await shrinkage(september), await shrinkage(october)],
      expected: [['10', 1], ['0', 0]],
    });
  });
});

describe('InventoryReportsService returns in their own month', () => {
  test('an October sale, returned in November', async () => {
    const reports = new InventoryReportsService(prisma);
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Centro' } });
    const product = await prisma.product.create({ data: { name: 'Jarabe' } });
    // 3 jarabes at $45 (cost 33) on Oct 10; one back by hand on Nov 5 and $5 refunded in Square on Nov 6.
    const sale = await prisma.sale.create({
      data: {
        squareId: `p-${Math.random()}`,
        locationId,
        totalRevenue: 135,
        totalCost: 33,
        grossProfit: 102,
        createdAt: new Date('2026-10-10T18:00:00Z'),
        items: { create: { productId: product.id, quantity: 3, price: 45, cost: 33 } },
      },
      include: { items: true },
    });
    const adjustment = await prisma.inventoryAdjustment.create({
      data: { locationId, productId: product.id, type: 'RETURN', quantity: 1, unitCost: 11, totalCost: 11 },
    });
    await prisma.saleReturn.create({
      data: {
        saleId: sale.id,
        clientRequestId: `r-${Math.random()}`,
        returnedAt: new Date('2026-11-05T18:00:00Z'),
        revenue: 45,
        cost: 11,
        cashRefunded: 45,
        items: { create: { saleItemId: sale.items[0].id, adjustmentId: adjustment.id, quantity: 1, revenue: 45, cost: 11 } },
      },
    });
    await prisma.saleReturn.create({
      data: { saleId: sale.id, clientRequestId: `square-refund:${Math.random()}`, returnedAt: new Date('2026-11-06T18:00:00Z'), revenue: 5, cost: 0 },
    });
    const october = { locationId, startDate: new Date('2026-10-01T06:00:00Z'), endDate: new Date('2026-11-01T05:59:59Z') };
    const november = { locationId, startDate: new Date('2026-11-01T06:00:00Z'), endDate: new Date('2026-12-01T05:59:59Z') };
    const month = async (period: typeof october) => {
      const [cogs, margin, pnl] = await Promise.all([
        reports.getCOGSReport(period),
        reports.getProfitMarginReport(period),
        reports.getProfitAndLossReport(period),
      ]);
      return {
        cogs: [cogs.summary.totalUnitsSold, cogs.summary.totalRevenue, cogs.summary.totalCOGS, cogs.summary.grossProfit],
        cogsByProduct: cogs.byProduct.map((p) => [p.productName, p.unitsSold, p.totalRevenue, p.totalCost]),
        margin: margin.byProduct.map((p) => [p.productName, p.unitsSold, p.revenue, p.cost]),
        marginByDay: margin.trends.map((d) => [d.date, d.revenue, d.cost]),
        pnl: [pnl.revenue.sales, pnl.revenue.returns, pnl.revenue.netSales, pnl.costOfGoodsSold.productCosts, pnl.costOfGoodsSold.returns, pnl.costOfGoodsSold.total, pnl.grossProfit.amount],
      };
    };

    assert({
      given: 'the month of the sale',
      should: 'count the sale as sold, whatever came back later',
      actual: await month(october),
      expected: {
        cogs: [3, '135', '33', '102'],
        cogsByProduct: [['Jarabe', 3, '135', '33']],
        margin: [['Jarabe', 3, '135', '33']],
        marginByDay: [['2026-10-10', '135', '33']],
        pnl: ['135', '0', '135', '33', '0', '33', '102'],
      },
    });
    assert({
      given: 'the month of the returns',
      should: 'count what came back as Devoluciones, by product and on the day it came back',
      actual: await month(november),
      expected: {
        cogs: [-1, '-45', '-11', '-34'],
        cogsByProduct: [['Jarabe', -1, '-45', '-11']],
        margin: [['Jarabe', -1, '-45', '-11']],
        marginByDay: [['2026-11-05', '-45', '-11']],
        // the $5 refund has no product, so only the P&L carries it
        pnl: ['0', '50', '-50', '0', '11', '-11', '-39'],
      },
    });
  });
});

describe('relabel of the 2026-11-04 Lolita migration fixes', () => {
  test('the six count corrections, next to one that is not on the list', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const reports = new InventoryReportsService(prisma);
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Lolita' } });
    const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
    const listed = ['31e5eb4b-d39e-4896-b18a-7102f5e589b4', 'ba17fe40-0d78-4e3c-9445-661070c645fe'];
    await prisma.inventoryAdjustment.createMany({
      data: [...listed, 'not-on-the-list'].map((id) => ({ id, locationId, productId, type: 'COUNT_CORRECTION' as const, quantity: -2, unitCost: 10, totalCost: 20 })),
    });

    await prisma.$executeRawUnsafe(readFileSync(
      join(__dirname, '../../../../prisma/migrations/20261105120100_relabel_lolita_migration_counts/migration.sql'), 'utf8'));
    const pnl = await reports.getProfitAndLossReport({ locationId });

    assert({
      given: 'two listed count corrections and one that is not',
      should: 'leave only the unlisted one as shrinkage',
      actual: pnl.operatingExpenses.shrinkage,
      expected: '20',
    });
    assert({
      given: 'the relabel',
      should: 'leave one audit entry per relabeled adjustment',
      actual: (await prisma.auditLog.findMany({ where: { entityId: { in: listed } } })).map((a) => a.action),
      expected: ['RELABEL_ADJUSTMENT_TYPE', 'RELABEL_ADJUSTMENT_TYPE'],
    });
  });
});

describe('InventoryReportsService valuation lots', () => {
  test('a lot set by a Conteo inicial', async () => {
    const reports = new InventoryReportsService(prisma);
    const { id: locationId } = await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name: 'Lolita' } });
    const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
    await prisma.inventory.create({
      data: { productId, locationId, quantity: 4, unitCost: 10, receivedAt: new Date('2026-10-01'), expiryDate: new Date('2027-01-01T18:00:00Z'), lotNumber: 'A12' },
    });

    const report: any = await reports.getInventoryValuationReport({ locationId, productId });
    const [batch] = report.byProduct[0].batches;

    assert({
      given: 'a batch with a lot and no receiving',
      should: 'show its caducidad and lote',
      actual: [batch.expiryDate?.toISOString().slice(0, 10), batch.batchNumber],
      expected: ['2027-01-01', 'A12'],
    });
  });
});
