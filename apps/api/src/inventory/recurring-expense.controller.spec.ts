import { assert } from 'riteway/vitest';
import { RecurringExpenseController } from './recurring-expense.controller';

/** A session at Centro with this role, assigned only to Centro. */
const requestAs = (role: string) => ({
  employee: { id: 'e1' },
  currentLocation: { role, locationId: 'centro' },
  accessibleLocations: [{ locationId: 'centro', isActive: true }],
}) as any; // fixture: only the fields the controller reads

/** 'done', or the refusal's message. */
const outcome = (promise: Promise<unknown>) => promise.then(() => 'done', (e: any) => e.response?.message ?? e.message);

function setup(ruleLocationId: string | null) {
  const rule = { id: 'r1', locationId: ruleLocationId, amount: null };
  const service = {
    listRules: vi.fn().mockResolvedValue([]),
    getRule: vi.fn().mockResolvedValue(rule),
    createRule: vi.fn().mockResolvedValue(rule),
    updateRule: vi.fn().mockResolvedValue(rule),
    deleteRule: vi.fn().mockResolvedValue(undefined),
  };
  return { service, controller: new RecurringExpenseController(service as any, {} as any) };
}

describe('RecurringExpenseController', () => {
  test("an accountant and another store's rules", async () => {
    const { service, controller } = setup('norte');

    assert({
      given: 'an accountant of Centro creating, editing or deleting a rule at Norte',
      should: 'refuse each and change nothing',
      actual: [
        await outcome(controller.createRule({ locationId: 'norte' }, requestAs('ACCOUNTANT'))),
        await outcome(controller.updateRule('r1', { amount: 1 }, requestAs('ACCOUNTANT'))),
        await outcome(controller.updateRule('r1', { locationId: 'norte' }, requestAs('ACCOUNTANT'))),
        await outcome(controller.deleteRule('r1', requestAs('ACCOUNTANT'))),
        service.createRule.mock.calls.length + service.updateRule.mock.calls.length + service.deleteRule.mock.calls.length,
      ],
      expected: [...Array(4).fill('No tienes acceso a esta sucursal'), 0],
    });
  });

  test('moving a rule to a store the accountant runs', async () => {
    const { service, controller } = setup('centro');

    assert({
      given: 'an accountant of Centro moving a Centro rule to Norte',
      should: 'refuse it',
      actual: [await outcome(controller.updateRule('r1', { locationId: 'norte' }, requestAs('ACCOUNTANT'))), service.updateRule.mock.calls.length],
      expected: ['No tienes acceso a esta sucursal', 0],
    });
  });

  test('a manager reading rules', async () => {
    const { service, controller } = setup('centro');

    assert({
      given: 'a manager listing rules with no store, and asking for the general ones',
      should: 'list their own store, and refuse the general ones',
      actual: [
        await outcome(controller.listRules(requestAs('MANAGER'))),
        service.listRules.mock.calls[0][0],
        await outcome(controller.listRules(requestAs('MANAGER'), undefined, 'general')),
      ],
      expected: ['done', { locationId: 'centro' }, 'Solo el dueño o el contador pueden ver gastos generales'],
    });
  });
});

describe('RecurringExpenseController payroll config', () => {
  const stored = [
    { teamMemberId: 'TM-centro', mode: 'FIXED', fixedAmount: 3000, homeLocationId: 'centro' },
    { teamMemberId: 'TM-norte', mode: 'FIXED', fixedAmount: 4000, homeLocationId: 'norte' },
    { teamMemberId: 'TM-hours', mode: 'HOURS', fixedAmount: null, homeLocationId: null },
  ];
  function configSetup() {
    const service = {
      getPayrollConfig: vi.fn().mockResolvedValue(stored),
      setPayrollConfig: vi.fn().mockResolvedValue(stored),
    };
    return { service, controller: new RecurringExpenseController(service as any, {} as any) };
  }

  test("an accountant of one store and another store's salaries", async () => {
    const { service, controller } = configSetup();

    assert({
      given: 'a Centro-only accountant setting a Norte home, or changing someone whose home is Norte',
      should: 'refuse both and save nothing',
      actual: [
        await outcome(controller.setPayrollConfig([{ teamMemberId: 'TM-hours', mode: 'FIXED', fixedAmount: 1, homeLocationId: 'norte' }], requestAs('ACCOUNTANT'))),
        await outcome(controller.setPayrollConfig([{ teamMemberId: 'TM-norte', fixedAmount: 1 }], requestAs('ACCOUNTANT'))),
        service.setPayrollConfig.mock.calls.length,
      ],
      expected: ['No tienes acceso a esta sucursal', 'No tienes acceso a esta sucursal', 0],
    });
  });

  test('reading salaries', async () => {
    const { controller } = configSetup();
    const ids = async (role: string) => (await controller.getPayrollConfig(requestAs(role))).data.map((r) => r.teamMemberId);

    assert({
      given: 'a Centro-only accountant, and the owner, reading payroll config',
      should: 'leave out the Norte-home row for the accountant only',
      actual: [await ids('ACCOUNTANT'), await ids('OWNER')],
      expected: [['TM-centro', 'TM-hours'], ['TM-centro', 'TM-norte', 'TM-hours']],
    });
  });
});

describe('RecurringExpenseController upcoming', () => {
  function upcomingSetup() {
    const service = { upcoming: vi.fn().mockResolvedValue({ data: [], payrollUnavailable: true }) };
    const labor = { getShiftsByPerson: vi.fn().mockResolvedValue([{ teamMemberId: 'ana', name: 'Ana López', shifts: [] }]) };
    return { service, labor, controller: new RecurringExpenseController(service as any, labor as any) };
  }

  test("a manager's upcoming list", async () => {
    const { service, controller } = upcomingSetup();
    await controller.upcoming(requestAs('MANAGER'));

    assert({
      given: 'a manager asking without a store or days',
      should: 'read their own store, 30 days ahead',
      actual: (({ locationId, days }) => ({ locationId, days }))(service.upcoming.mock.calls[0][0]),
      expected: { locationId: 'centro', days: 30 },
    });

    assert({
      given: 'a manager asking for general ones',
      should: 'refuse it',
      actual: await outcome(controller.upcoming(requestAs('MANAGER'), undefined, 'general')),
      expected: 'Solo el dueño o el contador pueden ver gastos generales',
    });

    assert({
      given: 'days that are not a whole number from 0 to 366',
      should: 'refuse each',
      actual: [await outcome(controller.upcoming(requestAs('OWNER'), undefined, undefined, 'x')), await outcome(controller.upcoming(requestAs('OWNER'), undefined, undefined, '400'))],
      expected: Array(2).fill('days debe ser un número entero de 0 a 366'),
    });
  });

  test("payroll hours come from everyone's Square timecards", async () => {
    const { service, labor, controller } = upcomingSetup();
    const response = await controller.upcoming(requestAs('OWNER'), undefined, undefined, '7');
    const { staff, days } = service.upcoming.mock.calls[0][0];

    assert({
      given: 'the service asking for 1–27 Nov, and Square labor down',
      should: 'give the shifts by person for that span, and pass the flag on',
      actual: [days, await staff('2026-11-01', '2026-11-27'), labor.getShiftsByPerson.mock.calls, response],
      expected: [
        7,
        [{ teamMemberId: 'ana', name: 'Ana López', shifts: [] }],
        [['2026-11-01', '2026-11-27']],
        { success: true, data: [], payrollUnavailable: true },
      ],
    });
  });
});
