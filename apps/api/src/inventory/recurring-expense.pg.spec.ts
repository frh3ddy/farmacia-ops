/**
 * Recurring expense rules and payroll config against a real Postgres engine
 * (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { RecurringExpenseService } from './recurring-expense.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let service: RecurringExpenseService;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  service = new RecurringExpenseService(prisma);
}, 120_000);

afterAll(() => stop?.());

const newLocation = async (name = 'Centro') =>
  (await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name } })).id;

/** 'done', or the refusal's message. */
const outcome = (promise: Promise<unknown>) => promise.then(() => 'done', (e: Error) => e.message);

/** A valid monthly rent rule; override any field. */
const rent = (locationId: string | null, overrides: Record<string, unknown> = {}) => ({
  locationId, type: 'RENT', name: 'Renta', kind: 'FIXED', amount: 8000,
  freq: 'MONTHLY', dayOfMonth: 1, startDate: '2026-12-01', periodRule: 'DUE_MONTH', ...overrides,
}) as any; // fixture: the body as a client sends it

describe('RecurringExpenseService rules', () => {
  test('a rule that is missing what it needs', async () => {
    const locationId = await newLocation();
    const cases: [Record<string, unknown>, string][] = [
      [{ name: ' ' }, 'El gasto recurrente necesita un nombre'],
      [{ type: 'LUNCH' }, 'Tipo de gasto no válido'],
      [{ kind: 'SOMETIMES' }, 'Tipo de monto no válido: FIXED, VARIES o PAYROLL'],
      [{ freq: 'DAILY' }, 'Frecuencia no válida'],
      [{ amount: undefined }, 'Un gasto fijo necesita un monto mayor que cero'],
      [{ amount: -1 }, 'Un gasto fijo necesita un monto mayor que cero'],
      [{ dayOfMonth: 32 }, 'Indica el día del mes (1 a 31)'],
      [{ freq: 'WEEKLY', weekday: undefined }, 'Indica el día de la semana (0 domingo a 6 sábado)'],
      [{ freq: 'BIWEEKLY', weekday: 7 }, 'Indica el día de la semana (0 domingo a 6 sábado)'],
      [{ startDate: '1 dic' }, 'La fecha de inicio debe ser AAAA-MM-DD'],
      [{ periodRule: 'NEXT_MONTH' }, 'Regla de periodo no válida'],
      [{ remindDaysBefore: 2 }, 'El aviso debe ser 0, 1, 3 o 7 días antes'],
      [{ remindTime: '25:00' }, 'La hora del aviso debe ser HH:mm'],
      [{ kind: 'VARIES', autoPaid: true }, 'El pago automático solo aplica a montos fijos'],
      [{ kind: 'PAYROLL', locationId: null }, 'La nómina recurrente es por sucursal'],
    ];

    const outcomes = [];
    for (const [overrides] of cases) outcomes.push(await outcome(service.createRule(rent(locationId, overrides))));

    assert({
      given: 'a rule with each required field missing or out of range',
      should: 'refuse each with its reason and record nothing',
      actual: [outcomes, await prisma.recurringExpense.count({ where: { locationId } })],
      expected: [cases.map(([, message]) => message), 0],
    });
  });

  test('rules that vary or are payroll', async () => {
    const locationId = await newLocation();

    const luz = await service.createRule(rent(locationId, { type: 'UTILITIES', name: 'Luz', kind: 'VARIES', amount: 900, freq: 'BIMONTHLY', periodRule: 'BILL_MONTHS' }));
    const nomina = await service.createRule(rent(locationId, { type: 'OTHER', name: 'Nómina', kind: 'PAYROLL', amount: undefined, freq: 'WEEKLY', dayOfMonth: undefined, weekday: 6 }));

    assert({
      given: 'a varying bill sent with an amount, and a payroll rule sent with another type',
      should: 'drop the amount (it is estimated) and make the payroll rule a PAYROLL expense',
      actual: [luz.amount, nomina.type, nomina.dayOfMonth, nomina.weekday],
      expected: [null, 'PAYROLL', null, 6],
    });
  });

  test('editing a rule', async () => {
    const locationId = await newLocation();
    const { id } = await service.createRule(rent(locationId));

    assert({
      given: 'an edit to a valid amount, then one that turns on direct debit for a varying bill',
      should: 'keep the first and refuse the second against the whole rule',
      actual: [
        await outcome(service.updateRule(id, { amount: 8500 })),
        await outcome(service.updateRule(id, { kind: 'VARIES', autoPaid: true })),
        (await prisma.recurringExpense.findUniqueOrThrow({ where: { id } })).amount?.toString(),
      ],
      expected: ['done', 'El pago automático solo aplica a montos fijos', '8500'],
    });
  });

  test('listing by store', async () => {
    const centro = await newLocation();
    const norte = await newLocation('Norte');
    await service.createRule(rent(centro, { name: 'Renta Centro' }));
    await service.createRule(rent(norte, { name: 'Renta Norte' }));
    await service.createRule(rent(null, { type: 'PROFESSIONAL', name: `Contador ${centro}` }));

    const general = await service.listRules({ locationId: null });

    assert({
      given: 'a rule at each of two stores and a general one',
      should: "list one store's rules alone, and the general ones apart",
      actual: [
        (await service.listRules({ locationId: centro })).map((r) => r.name),
        general.some((r) => r.name === `Contador ${centro}`),
        general.every((r) => r.locationId === null),
      ],
      expected: [['Renta Centro'], true, true],
    });
  });

  test('deleting a rule that was already paid', async () => {
    const locationId = await newLocation();
    const { id } = await service.createRule(rent(locationId));
    const paid = await prisma.expense.create({
      data: { locationId, type: 'RENT', amount: 8000, date: new Date('2026-12-01T12:00:00-06:00'), recurringExpenseId: id, occurrenceDate: new Date('2026-12-01') },
    });

    await service.deleteRule(id);

    assert({
      given: 'a rule with a payment linked to it',
      should: 'delete the rule and keep the payment',
      actual: [await prisma.recurringExpense.count({ where: { id } }), (await prisma.expense.findUniqueOrThrow({ where: { id: paid.id } })).recurringExpenseId],
      expected: [0, null],
    });
  });
});

describe('RecurringExpenseService payroll config', () => {
  test('setting how people are paid', async () => {
    const centro = await newLocation();
    const fixed = `TM-fixed-${centro}`;
    const hourly = `TM-hours-${centro}`;

    const refusals = [
      await outcome(service.setPayrollConfig([{ teamMemberId: fixed, mode: 'FIXED', homeLocationId: centro }])),
      await outcome(service.setPayrollConfig([{ teamMemberId: fixed, mode: 'FIXED', fixedAmount: 3000 }])),
      await outcome(service.setPayrollConfig([{ teamMemberId: fixed, mode: 'MONTHLY' as any }])),
    ];
    await service.setPayrollConfig([
      { teamMemberId: fixed, mode: 'FIXED', fixedAmount: 3000, homeLocationId: centro },
      { teamMemberId: hourly, included: false },
    ]);
    await service.setPayrollConfig([{ teamMemberId: hourly, included: true }]);
    const config = (await service.getPayrollConfig()).filter((c) => [fixed, hourly].includes(c.teamMemberId));

    assert({
      given: 'a fixed salary with no amount, with no home store, an unknown mode, then valid rows and a later change',
      should: 'refuse the invalid ones and keep each person\'s latest settings',
      actual: [refusals, config.map((c) => [c.teamMemberId, c.included, c.mode, c.fixedAmount?.toString() ?? null, c.homeLocationId])],
      expected: [
        ['Un sueldo fijo necesita un monto mayor que cero', 'Un sueldo fijo necesita su sucursal', 'Modo de pago no válido: HOURS o FIXED'],
        [[fixed, true, 'FIXED', '3000', centro], [hourly, true, 'HOURS', null, null]],
      ],
    });
  });
});

describe('RecurringExpenseService and deleted stores', () => {
  test("a store with rules or someone's home", async () => {
    const withRule = await newLocation();
    const withHome = await newLocation('Norte');
    const { id: ruleId } = await service.createRule(rent(withRule));
    await service.setPayrollConfig([{ teamMemberId: `TM-home-${withHome}`, mode: 'FIXED', fixedAmount: 3000, homeLocationId: withHome }]);

    const deleting = async (id: string) => outcome(prisma.location.delete({ where: { id } }));

    assert({
      given: "deleting a store that has a recurring rule, and one that is a fixed salary's home",
      should: "refuse both, rather than turn the store's rent into a general rule or leave the salary with no store",
      actual: [
        (await deleting(withRule)) === 'done',
        (await deleting(withHome)) === 'done',
        (await prisma.recurringExpense.findUniqueOrThrow({ where: { id: ruleId } })).locationId,
        (await prisma.payrollConfig.findUniqueOrThrow({ where: { teamMemberId: `TM-home-${withHome}` } })).homeLocationId,
      ],
      expected: [false, false, withRule, withHome],
    });
  });
});
