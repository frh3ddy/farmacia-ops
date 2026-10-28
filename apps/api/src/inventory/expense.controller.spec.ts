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
  return { service, controller: new ExpenseController(service as any) };
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
