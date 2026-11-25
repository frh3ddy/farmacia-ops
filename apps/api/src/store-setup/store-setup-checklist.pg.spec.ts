/**
 * The owner's "Configurar sucursal" checklist: four items per store, read from
 * the real tables (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { updateStockAlertSettings } from '../stock-alerts/stock-alert-settings';
import { storeSetupChecklist } from './store-setup-checklist';

let prisma: PrismaService;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
}, 120_000);

afterAll(() => stop?.());

const store = async (name = 'Configurar') => (await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name } })).id;
const employee = async (
  locationId: string,
  name: string,
  { pin = null as string | null, isActive = true, assignmentActive = true, role = 'CASHIER' as 'CASHIER' | 'OWNER' } = {},
) => {
  const { id } = await prisma.employee.create({ data: { name, pin, pinSalt: pin && 'salt', isActive } });
  await prisma.employeeLocationAssignment.create({ data: { employeeId: id, locationId, role, isActive: assignmentActive } });
  return id;
};
const rule = (locationId: string | null, paused = false) =>
  prisma.recurringExpense.create({
    data: { locationId, type: 'RENT', name: 'Renta', kind: 'FIXED', amount: 1000, freq: 'MONTHLY', dayOfMonth: 1, startDate: new Date('2026-12-01'), paused },
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each item has its own fields
const item = async (locationId: string, key: string) => (await storeSetupChecklist(prisma, locationId)).items.find((i) => i.key === key) as Record<string, any> | undefined;
const refusal = (promise: Promise<unknown>) => promise.then(() => 'done', (e: Error) => e.message);

describe('storeSetupChecklist', () => {
  test('a new store', async () => {
    const locationId = await store();
    const karla = await employee(locationId, 'Karla Ruiz');
    assert({
      given: 'a store with an employee without a PIN and nothing else set up',
      should: 'list the four items in order, none done',
      actual: await storeSetupChecklist(prisma, locationId),
      expected: {
        locationId,
        done: 0,
        total: 4,
        items: [
          { key: 'EMPLOYEE_PINS', done: false, missingPin: [{ id: karla, name: 'Karla Ruiz' }] },
          { key: 'RECURRING_EXPENSES', done: false, activeRules: 0 },
          { key: 'STOCK_COUNT', done: false, endedAt: null },
          { key: 'RECEIVING', done: false, reviewed: null },
        ],
      },
    });
  });

  test('employee PINs', async () => {
    const locationId = await store();
    const other = await store('Otra');
    await employee(locationId, 'Con PIN', { pin: 'hash' });
    await employee(locationId, 'Dado de baja', { isActive: false });
    await employee(locationId, 'Ya no trabaja aquí', { assignmentActive: false });
    await employee(other, 'De otra sucursal');
    assert({
      given: 'employees with a PIN, inactive, no longer assigned here, or at another store',
      should: 'count the item done',
      actual: await item(locationId, 'EMPLOYEE_PINS'),
      expected: { key: 'EMPLOYEE_PINS', done: true, missingPin: [] },
    });

    const owner = await employee(locationId, 'Fredy Méndez', { role: 'OWNER' });
    assert({
      given: 'the owner, assigned here without a PIN',
      should: 'list the owner too',
      actual: (await item(locationId, 'EMPLOYEE_PINS'))?.missingPin,
      expected: [{ id: owner, name: 'Fredy Méndez' }],
    });

    const empty = await store('Sin empleados');
    assert({ given: 'a store with no employees', should: 'count the item done', actual: (await item(empty, 'EMPLOYEE_PINS'))?.done, expected: true });
  });

  test('recurring expenses', async () => {
    const locationId = await store();
    const other = await store('Otra');
    await rule(locationId, true);
    await rule(null);
    await rule(other);
    assert({
      given: 'a paused rule here, a general rule, and another store\'s rule',
      should: 'count none of them',
      actual: await item(locationId, 'RECURRING_EXPENSES'),
      expected: { key: 'RECURRING_EXPENSES', done: false, activeRules: 0 },
    });

    await rule(locationId);
    await rule(locationId);
    assert({
      given: 'two active rules at the store',
      should: 'count them and mark the item done',
      actual: await item(locationId, 'RECURRING_EXPENSES'),
      expected: { key: 'RECURRING_EXPENSES', done: true, activeRules: 2 },
    });
  });

  test('the opening stock count', async () => {
    const locationId = await store();
    const other = await store('Otra');
    await prisma.stockCount.create({ data: { locationId: other, endedAt: new Date('2026-11-20T15:00:00Z') } });
    await prisma.stockCount.create({ data: { locationId, openLocationId: locationId } });
    assert({
      given: 'a count still open here, and an ended count at another store',
      should: 'not be done',
      actual: await item(locationId, 'STOCK_COUNT'),
      expected: { key: 'STOCK_COUNT', done: false, endedAt: null },
    });

    await prisma.stockCount.create({ data: { locationId, endedAt: new Date('2026-11-10T15:00:00Z') } });
    await prisma.stockCount.create({ data: { locationId, endedAt: new Date('2026-11-21T15:00:00Z') } });
    assert({
      given: 'two ended counts at the store',
      should: 'be done, with the latest end',
      actual: await item(locationId, 'STOCK_COUNT'),
      expected: { key: 'STOCK_COUNT', done: true, endedAt: new Date('2026-11-21T15:00:00Z') },
    });
  });

  test('who receives from suppliers', async () => {
    const locationId = await store();
    const { id: by } = await prisma.employee.create({ data: { name: 'Fredy Méndez' } });
    await updateStockAlertSettings(prisma, locationId, { receivingReviewed: true }, by);
    const receiving = await item(locationId, 'RECEIVING');
    assert({
      given: 'the owner confirmed who receives',
      should: 'be done, with who reviewed it',
      actual: [receiving?.done, receiving?.reviewed?.by],
      expected: [true, { id: by, name: 'Fredy Méndez' }],
    });
  });

  test('stores that cannot be set up', async () => {
    const closed = await store('Cerrada');
    await prisma.location.update({ where: { id: closed }, data: { isActive: false } });
    assert({
      given: 'an unknown store and a closed store',
      should: 'refuse both',
      actual: [await refusal(storeSetupChecklist(prisma, 'no-existe')), await refusal(storeSetupChecklist(prisma, closed))],
      expected: ['Sucursal no encontrada', 'Sucursal no encontrada'],
    });
  });
});
