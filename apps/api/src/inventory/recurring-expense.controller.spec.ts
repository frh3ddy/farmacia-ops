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
  return { service, controller: new RecurringExpenseController(service as any) };
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
