import { assert } from 'riteway/vitest';
import { InventoryReportsController } from './inventory-reports.controller';

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
});
