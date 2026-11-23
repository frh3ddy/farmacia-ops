import { assert } from 'riteway/vitest';
import { ExpenseController } from './expense.controller';

// A manager assigned only to "centro".
const managerRequest = () => ({
  employee: { id: 'e1' },
  currentLocation: { role: 'MANAGER', locationId: 'centro' },
  accessibleLocations: [{ locationId: 'centro', isActive: true }],
}) as any; // fixture: only the fields the controller reads

/** 'done', or the refusal's message. */
const outcome = (promise: Promise<unknown>) => promise.then(() => 'done', (e: any) => e.response?.message ?? e.message);

const expenseAt = (locationId: string) => ({ id: 'x1', locationId, amount: { toString: () => '100' } });

function setup(locationId: string) {
  const service = {
    getExpense: vi.fn().mockResolvedValue(expenseAt(locationId)),
    updateExpense: vi.fn().mockResolvedValue(expenseAt(locationId)),
    deleteExpense: vi.fn().mockResolvedValue({ success: true }),
  };
  return { service, controller: new ExpenseController(service as any, {} as any) };
}

describe('ExpenseController by id', () => {
  test("another location's expense", async () => {
    const { service, controller } = setup('norte');

    assert({
      given: "a manager of Centro reading, editing and deleting one of Norte's expenses",
      should: 'refuse all three',
      actual: [
        await outcome(controller.getExpense('x1', managerRequest())),
        await outcome(controller.updateExpense('x1', { amount: 1 }, managerRequest())),
        await outcome(controller.deleteExpense('x1', managerRequest())),
      ],
      expected: Array(3).fill('No tienes acceso a esta sucursal'),
    });
    assert({
      given: 'the refused edit and delete',
      should: 'change nothing',
      actual: [service.updateExpense.mock.calls.length, service.deleteExpense.mock.calls.length],
      expected: [0, 0],
    });
  });

  test("the manager's own location", async () => {
    const { controller } = setup('centro');

    assert({
      given: "a manager of Centro reading, editing and deleting one of Centro's expenses",
      should: 'allow all three',
      actual: [
        await outcome(controller.getExpense('x1', managerRequest())),
        await outcome(controller.updateExpense('x1', { amount: 1 }, managerRequest())),
        await outcome(controller.deleteExpense('x1', managerRequest())),
      ],
      expected: ['done', 'done', 'done'],
    });
  });
});

const requestAs = (role: string) => ({
  employee: { id: 'e1' },
  currentLocation: { role, locationId: 'centro' },
  accessibleLocations: [{ locationId: 'centro', isActive: true }],
}) as any; // fixture: only the fields the controller reads

const generalOnly = 'Solo el dueño o el contador pueden ver gastos generales';

function generalSetup() {
  const service = {
    getExpense: vi.fn().mockResolvedValue(expenseAt(null as any)),
    updateExpense: vi.fn().mockResolvedValue(expenseAt(null as any)),
    deleteExpense: vi.fn().mockResolvedValue({ success: true }),
    createExpense: vi.fn().mockImplementation(async (input) => ({ ...input, amount: { toString: () => String(input.amount) } })),
    listExpenses: vi.fn().mockResolvedValue([]),
    getExpenseSummary: vi.fn().mockResolvedValue({}),
  };
  return { service, controller: new ExpenseController(service as any, {} as any) };
}

const newExpense = { type: 'PROFESSIONAL' as const, amount: 1200, date: '2026-11-10' };

describe('ExpenseController general expenses', () => {
  test('a manager', async () => {
    const { service, controller } = generalSetup();

    assert({
      given: 'a manager recording, reading, editing, deleting or listing general expenses',
      should: 'refuse each and change nothing',
      actual: [
        await outcome(controller.createExpense({ ...newExpense, locationId: null }, requestAs('MANAGER'))),
        await outcome(controller.getExpense('x1', requestAs('MANAGER'))),
        await outcome(controller.updateExpense('x1', { amount: 1 }, requestAs('MANAGER'))),
        await outcome(controller.deleteExpense('x1', requestAs('MANAGER'))),
        await outcome(controller.listExpenses(requestAs('MANAGER'), undefined, 'general')),
        await outcome(controller.getExpenseSummary(requestAs('MANAGER'), undefined, 'general')),
        service.createExpense.mock.calls.length + service.updateExpense.mock.calls.length + service.deleteExpense.mock.calls.length,
      ],
      expected: [...Array(6).fill(generalOnly), 0],
    });
  });

  test('an accountant', async () => {
    const { service, controller } = generalSetup();

    const outcomes = [
      await outcome(controller.createExpense({ ...newExpense, locationId: null }, requestAs('ACCOUNTANT'))),
      await outcome(controller.getExpense('x1', requestAs('ACCOUNTANT'))),
      await outcome(controller.updateExpense('x1', { amount: 1 }, requestAs('ACCOUNTANT'))),
      await outcome(controller.deleteExpense('x1', requestAs('ACCOUNTANT'))),
      await outcome(controller.listExpenses(requestAs('ACCOUNTANT'), undefined, 'general')),
      await outcome(controller.getExpenseSummary(requestAs('ACCOUNTANT'), undefined, 'general')),
    ];

    assert({
      given: 'an accountant doing the same',
      should: 'allow each, reading only the general expenses',
      actual: [
        outcomes,
        service.createExpense.mock.calls[0][0].locationId,
        service.listExpenses.mock.calls[0][0].locationId,
        service.getExpenseSummary.mock.calls[0][0].locationId,
      ],
      expected: [Array(6).fill('done'), null, null, null],
    });
  });

  test('a store left out', async () => {
    const { service, controller } = generalSetup();

    await controller.createExpense(newExpense as any, requestAs('MANAGER'));

    assert({
      given: 'a new expense with no locationId at all',
      should: 'record it at the session store, as before',
      actual: service.createExpense.mock.calls[0][0].locationId,
      expected: 'centro',
    });
  });
});

describe('ExpenseController period', () => {
  test('creating and editing with a period', async () => {
    const { service, controller } = generalSetup();
    const period = { periodStart: '2026-12-01', periodEnd: '2026-12-31' };

    await controller.createExpense({ ...newExpense, locationId: 'centro', ...period }, requestAs('MANAGER'));
    service.getExpense.mockResolvedValue(expenseAt('centro'));
    await controller.updateExpense('x1', { periodStart: null, periodEnd: null }, requestAs('MANAGER'));

    assert({
      given: 'a period on create, and both ends cleared on edit',
      should: 'pass them to the service',
      actual: [
        [service.createExpense.mock.calls[0][0].periodStart, service.createExpense.mock.calls[0][0].periodEnd],
        [service.updateExpense.mock.calls[0][1].periodStart, service.updateExpense.mock.calls[0][1].periodEnd],
      ],
      expected: [['2026-12-01', '2026-12-31'], [null, null]],
    });
  });
});

describe('ExpenseController payroll by store', () => {
  /** A labor service whose payroll summary has these store rows (null: a Square location that isn't ours). */
  function payrollSetup(stores: { locationId: string | null; workedMinutes: number }[]) {
    const labor = { getPayrollSummary: vi.fn().mockResolvedValue({ stores }) };
    const service = {
      createPayrollExpenses: vi.fn().mockImplementation(async (input) => (await input.hours()).map((s: { locationId: string }) => ({ ...s, amount: { toString: () => '1' } }))),
    };
    return { labor, service, controller: new ExpenseController(service as any, labor as any) };
  }
  const body = { teamMemberId: 'TM1', periodStart: '2026-11-30', periodEnd: '2026-12-06', amount: 1000, date: '2026-12-07' };

  test("hours at a store the manager doesn't run", async () => {
    const { controller } = payrollSetup([{ locationId: 'centro', workedMinutes: 60 }, { locationId: 'norte', workedMinutes: 60 }]);

    assert({
      given: 'a manager of Centro paying someone who also worked at Norte',
      should: 'refuse the payment',
      actual: await outcome(controller.createPayrollExpense(body, requestAs('MANAGER'))),
      expected: 'No tienes acceso a esta sucursal',
    });
  });

  test("the person's hours for the period", async () => {
    const { labor, service, controller } = payrollSetup([{ locationId: 'centro', workedMinutes: 90 }, { locationId: null, workedMinutes: 30 }]);

    await controller.createPayrollExpense(body, requestAs('MANAGER'));

    assert({
      given: "a payment for a period, with some hours at a Square location that isn't ours",
      should: "read that person's hours for that period and split only over our stores",
      actual: [
        labor.getPayrollSummary.mock.calls[0],
        await service.createPayrollExpenses.mock.calls[0][0].hours(),
        service.createPayrollExpenses.mock.calls[0][0].createdBy,
      ],
      expected: [
        ['TM1', { startDate: '2026-11-30', endDate: '2026-12-06' }],
        [{ locationId: 'centro', workedMinutes: 90 }],
        'e1',
      ],
    });
  });

  test('missing fields', async () => {
    const { labor, controller } = payrollSetup([]);

    assert({
      given: 'no team member, amount or date',
      should: "refuse without asking Square for hours",
      actual: [
        await outcome(controller.createPayrollExpense({ ...body, teamMemberId: undefined } as any, requestAs('OWNER'))),
        await outcome(controller.createPayrollExpense({ ...body, date: undefined } as any, requestAs('OWNER'))),
        labor.getPayrollSummary.mock.calls.length,
      ],
      expected: ['Missing required fields: teamMemberId, amount, date', 'Missing required fields: teamMemberId, amount, date', 0],
    });
  });

  test("a replay of a payment booked at a store the manager doesn't run", async () => {
    const labor = { getPayrollSummary: vi.fn() };
    const service = { createPayrollExpenses: vi.fn().mockResolvedValue([{ locationId: 'norte', amount: { toString: () => '1000' } }]) };
    const controller = new ExpenseController(service as any, labor as any);

    assert({
      given: "a manager of Centro resending a request id that booked a payment at Norte",
      should: 'refuse rather than return Norte\'s expense',
      actual: await outcome(controller.createPayrollExpense({ ...body, clientRequestId: 'k' }, requestAs('MANAGER'))),
      expected: 'No tienes acceso a esta sucursal',
    });
  });
});
