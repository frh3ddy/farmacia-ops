import { assert } from 'riteway/vitest';
import { InventoryReportsController } from './inventory-reports.controller';
import { startOfBusinessMonth } from './business-date';

const requestAs = (role: string) => ({
  employee: { id: 'e1' },
  currentLocation: { role, locationId: 'centro' },
  accessibleLocations: [{ locationId: 'centro', isActive: true }],
}) as any; // fixture: only the fields the controller reads

function setup() {
  const reports = {
    getCOGSReport: vi.fn().mockResolvedValue({ summary: {} }),
    getInventoryValuationReport: vi.fn().mockResolvedValue({ summary: {}, agingSummary: {} }),
    getAdjustmentImpactReport: vi.fn().mockResolvedValue({ summary: {} }),
    getReceivingSummaryReport: vi.fn().mockResolvedValue({ summary: {} }),
    getProfitAndLossReport: vi.fn().mockResolvedValue({
      revenue: { sales: '100000', yastasServiceRevenue: '3000', total: '103000' },
      costOfGoodsSold: { productCosts: '60000', total: '60000' },
      operatingExpenses: { total: '500', byType: [{ type: 'PAYROLL', amount: '500' }], shrinkage: '0' },
      netProfit: { amount: '1000', marginPercent: '20.00' },
    }),
  };
  return { reports, controller: new InventoryReportsController(reports as any) };
}

const profitLossKeys = (data: object) => ['operatingExpenses', 'netProfit'].filter((key) => key in data);

describe('InventoryReportsController.getDashboardSummary', () => {
  test('roles that may not open the P&L', async () => {
    const { reports, controller } = setup();
    const dashboards = await Promise.all(['MANAGER', 'CASHIER'].map((role) => controller.getDashboardSummary(requestAs(role))));

    assert({
      given: 'a manager and a cashier opening the dashboard',
      should: 'leave out net profit and operating expenses (payroll, rent)',
      actual: dashboards.map(({ data }) => profitLossKeys(data)),
      expected: [[], []],
    });
    assert({
      given: 'the same dashboards',
      should: 'not compute the P&L at all',
      actual: reports.getProfitAndLossReport.mock.calls.length,
      expected: 0,
    });
  });

  test('roles that may open the P&L', async () => {
    const { controller } = setup();
    const dashboards = await Promise.all(['OWNER', 'ACCOUNTANT'].map((role) => controller.getDashboardSummary(requestAs(role))));

    assert({
      given: 'an owner and an accountant opening the dashboard',
      should: 'include net profit and operating expenses',
      actual: dashboards.map(({ data }) => profitLossKeys(data)),
      expected: [['operatingExpenses', 'netProfit'], ['operatingExpenses', 'netProfit']],
    });
  });

  test('the P&L lines behind net profit', async () => {
    // Net profit adds Yastás revenue (service income kept out of sales/gross profit),
    // and comes from sale totals, while `sales` sums sale items — which differ when a
    // discount is on the whole sale. The app builds the P&L card from these so its
    // rows add up to net profit.
    const { controller } = setup();
    const { data } = await controller.getDashboardSummary(requestAs('OWNER'));

    assert({
      given: 'an owner and a P&L with sales 100000, cost 60000 and Yastás 3000',
      should: 'carry them in netProfit next to the amount',
      actual: (data as any).netProfit,
      expected: { amount: '1000', marginPercent: '20.00', yastasServiceRevenue: '3000', salesRevenue: '100000', costOfSales: '60000' },
    });
  });
});

describe('InventoryReportsController.getBatchDetail', () => {
  test('a batch by id', async () => {
    const outcomeAt = (locationId: string) => {
      const reports = { getBatchDetail: vi.fn().mockResolvedValue({ batchId: 'b1', locationId }) };
      return new InventoryReportsController(reports as any)
        .getBatchDetail('b1', requestAs('MANAGER'))
        .then(() => 'done', (e: any) => e.response?.message ?? e.message);
    };

    assert({
      given: "a manager of Centro opening one of Norte's batches, then one of Centro's",
      should: "refuse Norte's and show Centro's",
      actual: [await outcomeAt('norte'), await outcomeAt('centro')],
      expected: ['No tienes acceso a esta sucursal', 'done'],
    });
  });
});

describe('InventoryReportsController.getDashboardSummary period and location', () => {
  afterEach(() => vi.useRealTimers());

  test('no dates given', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-01T03:00:00Z') }); // 9 pm Oct 31 in Mexico City
    const { reports, controller } = setup();
    await controller.getDashboardSummary(requestAs('OWNER'));

    assert({
      given: 'a dashboard opened on the evening of Oct 31 without a date range',
      should: 'cover October so far in Mexico City, not every sale ever recorded',
      actual: reports.getCOGSReport.mock.calls[0][0].startDate.toISOString(),
      expected: '2026-10-01T06:00:00.000Z',
    });
  });

  test('a manager of two locations picking one', async () => {
    const { reports, controller } = setup();
    const manager = { ...requestAs('MANAGER'), accessibleLocations: [{ locationId: 'centro', isActive: true }, { locationId: 'norte', isActive: true }] };
    await controller.getDashboardSummary(manager, 'norte');

    assert({
      given: 'a manager at Centro and Norte asking for Norte (the guard has checked access)',
      should: "show Norte's numbers, not Centro's",
      actual: reports.getCOGSReport.mock.calls[0][0].locationId,
      expected: 'norte',
    });
  });
});

describe('InventoryReportsController.getCOGSReport', () => {
  test('no dates', async () => {
    const { reports, controller } = setup();
    await controller.getCOGSReport(requestAs('OWNER'));

    assert({
      given: 'a COGS report asked for without dates',
      should: 'cover the current business month, not every sale ever',
      actual: reports.getCOGSReport.mock.calls[0][0].startDate?.toISOString(),
      expected: startOfBusinessMonth().toISOString(),
    });
  });
});
