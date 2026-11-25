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

describe('RecurringExpenseService upcoming', () => {
  const noStaff = () => Promise.reject(new Error('Square asked without a payroll rule'));
  const paid = (rule: { id: string; locationId: string | null }, occurrence: string, amount: number) =>
    prisma.expense.create({ data: {
      locationId: rule.locationId, type: 'RENT', amount, date: new Date(`${occurrence}T18:00:00Z`),
      recurringExpenseId: rule.id, occurrenceDate: new Date(`${occurrence}T00:00:00Z`),
    } });
  const brief = (o: any) => [o.name, o.dueDate, o.overdue, o.amount, o.amountIsEstimate, o.periodStart, o.periodEnd];

  test('fixed and varying bills', async () => {
    const centro = await newLocation();
    const renta = await service.createRule(rent(centro, { startDate: '2026-10-01', remindDaysBefore: 1, remindTime: '09:00' }));
    const luz = await service.createRule(rent(centro, { type: 'UTILITIES', name: 'Luz', kind: 'VARIES', amount: null, freq: 'MONTHLY', dayOfMonth: 15, startDate: '2026-08-15', periodRule: 'PREVIOUS_MONTH' }));
    await service.createRule(rent(centro, { name: 'Agua', kind: 'VARIES', amount: null, dayOfMonth: 10, startDate: '2026-12-10' }));
    await service.createRule(rent(centro, { name: 'Pausada', paused: true }));
    await paid(renta, '2026-10-01', 8000);
    for (const [day, amount] of [['2026-08-15', 100], ['2026-09-15', 200], ['2026-10-15', 300], ['2026-11-15', 601]] as const) await paid(luz, day, amount);

    const { data: upcoming, payrollUnavailable } = await service.upcoming({ locationId: centro, today: '2026-11-23', days: 30, staff: noStaff });

    assert({
      given: 'rent paid for October, Luz paid four times, Agua never paid, and a paused rule (today 23 Nov, 30 days)',
      should: "list unpaid due dates up to 23 Dec with amount or the last 3 payments' average, in due order",
      actual: [payrollUnavailable, ...upcoming.map(brief)],
      expected: [
        false,
        ['Renta', '2026-11-01', true, '8000', false, '2026-11-01', '2026-11-30'],
        ['Renta', '2026-12-01', false, '8000', false, '2026-12-01', '2026-12-31'],
        ['Agua', '2026-12-10', false, null, true, '2026-12-01', '2026-12-31'],
        ['Luz', '2026-12-15', false, '367', true, '2026-11-01', '2026-11-30'],
      ],
    });

    assert({
      given: 'an occurrence',
      should: 'carry its id, rule, store and reminder',
      actual: (({ id, ruleId, locationId, kind, type, autoPaid, remind, payroll }: any) => ({ id, ruleId, locationId, kind, type, autoPaid, remind, payroll }))(upcoming[0]),
      expected: { id: `${renta.id}:2026-11-01`, ruleId: renta.id, locationId: centro, kind: 'FIXED', type: 'RENT', autoPaid: false, remind: { daysBefore: 1, time: '09:00' }, payroll: undefined },
    });
  });

  test('which stores come back', async () => {
    const centro = await newLocation();
    const norte = await newLocation('Norte');
    const tag = (name: string) => `${name} ${centro}`; // other tests' rules share the database
    await service.createRule(rent(centro, { name: tag('Centro') }));
    await service.createRule(rent(norte, { name: tag('Norte') }));
    await service.createRule(rent(null, { name: tag('General'), type: 'PROFESSIONAL' }));
    const names = async (locationId?: string | null) =>
      (await service.upcoming({ locationId, today: '2026-11-23', days: 10, staff: async () => [] })).data
        .map((o) => o.name).filter((n) => n.endsWith(centro)).map((n) => n.split(' ')[0]).sort();

    assert({
      given: 'a store, general (null), and no scope',
      should: 'list that store only, general only, and everything',
      actual: [await names(centro), await names(null), await names(undefined)],
      expected: [['Centro'], ['General'], ['Centro', 'General', 'Norte']],
    });
  });

  test("payroll: this store's unpaid people", async () => {
    const centro = await newLocation();
    const norte = await newLocation('Norte');
    const id = (name: string) => `${name}-${centro}`;
    await service.setPayrollConfig([
      { teamMemberId: id('beto'), mode: 'FIXED', fixedAmount: 3000, homeLocationId: centro },
      { teamMemberId: id('carla'), included: false },
      { teamMemberId: id('dan'), mode: 'FIXED', fixedAmount: 2000, homeLocationId: norte },
    ]);
    await service.createRule(rent(centro, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2026-11-14' }));
    const shift = (date: string, locationId: string, workedMinutes: number, cost: number) => ({ date, locationId, workedMinutes, cost });
    const staff = vi.fn().mockResolvedValue([
      { teamMemberId: id('ana'), name: 'Ana', shifts: [shift('2026-11-10', centro, 480, 400), shift('2026-11-11', norte, 240, 200), shift('2026-11-15', centro, 300, 250.5), shift('2026-11-23', centro, 120, 100)] },
      { teamMemberId: id('beto'), name: 'Beto', shifts: [] },
      { teamMemberId: id('carla'), name: 'Carla', shifts: [shift('2026-11-16', centro, 600, 500)] },
      { teamMemberId: id('dan'), name: 'Dan', shifts: [shift('2026-11-16', centro, 600, 500)] },
    ]);
    // Paid for 7–13 Nov: Ana's Centro part and Beto's salary (Ana's Norte part is Norte's).
    for (const [teamMemberId, amount] of [[id('ana'), 400], [id('beto'), 3000]] as const) {
      await prisma.expense.create({ data: {
        locationId: centro, type: 'PAYROLL', amount, date: new Date('2026-11-14T18:00:00Z'), teamMemberId,
        periodStart: new Date('2026-11-07T00:00:00Z'), periodEnd: new Date('2026-11-13T00:00:00Z'),
      } });
    }

    const { data: upcoming } = await service.upcoming({ locationId: centro, today: '2026-11-23', days: 6, staff });

    assert({
      given: 'a weekly payroll since 14 Nov, everyone paid for its first week, today Monday 23 Nov',
      should: 'drop the paid week and list the overdue one and the current one (an estimate until it ends)',
      actual: upcoming.map(brief),
      expected: [
        ['Nómina', '2026-11-21', true, '3250.5', false, '2026-11-14', '2026-11-20'],
        ['Nómina', '2026-11-28', false, '3100', true, '2026-11-21', '2026-11-27'],
      ],
    });

    assert({
      given: 'Ana by hours, Beto fixed at Centro, Carla left out, Dan fixed at Norte',
      should: "list Ana with Centro's hours and Beto's salary, nobody else",
      actual: upcoming.map((o: any) => o.payroll),
      expected: [
        [{ teamMemberId: id('ana'), name: 'Ana', mode: 'HOURS', minutes: 300, amount: '250.5' }, { teamMemberId: id('beto'), name: 'Beto', mode: 'FIXED', minutes: 0, amount: '3000' }],
        [{ teamMemberId: id('ana'), name: 'Ana', mode: 'HOURS', minutes: 120, amount: '100' }, { teamMemberId: id('beto'), name: 'Beto', mode: 'FIXED', minutes: 0, amount: '3000' }],
      ],
    });

    assert({
      given: 'three payroll weeks',
      should: 'ask Square once, for the days they span',
      actual: staff.mock.calls,
      expected: [['2026-11-07', '2026-11-27']],
    });
  });

  test('payroll older than the lookback', async () => {
    const centro = await newLocation();
    const beto = `beto-${centro}`;
    await service.setPayrollConfig([{ teamMemberId: beto, mode: 'FIXED', fixedAmount: 3000, homeLocationId: centro }]);
    await service.createRule(rent(centro, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2025-11-01' }));
    const staff = vi.fn().mockResolvedValue([{ teamMemberId: beto, name: 'Beto', shifts: [] }]);

    const { data } = await service.upcoming({ locationId: centro, today: '2026-11-23', days: 6, staff });

    assert({
      given: 'a weekly payroll unpaid since a year ago, today 23 Nov',
      should: 'list only due dates in the last 56 days and ask Square only for their weeks',
      actual: [data[0].dueDate, data.length, staff.mock.calls],
      expected: ['2026-10-03', 9, [['2026-09-26', '2026-11-27']]],
    });
  });

  test('Square down', async () => {
    const centro = await newLocation();
    await service.createRule(rent(centro, { startDate: '2026-11-01' }));
    await service.createRule(rent(centro, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2026-11-28' }));

    const { data, payrollUnavailable } = await service.upcoming({ locationId: centro, today: '2026-11-23', days: 6, staff: () => Promise.reject(new Error('Square 502')) });

    assert({
      given: 'a rent and a payroll rule while Square labor fails',
      should: 'still list the rent, and the payroll without people or amount, flagged',
      actual: [payrollUnavailable, data.map((o: any) => [o.name, o.dueDate, o.amount, o.payroll])],
      expected: [true, [['Renta', '2026-11-01', '8000', undefined], ['Nómina', '2026-11-28', null, null]]],
    });
  });
});

describe('RecurringExpenseService pay', () => {
  const noStaff = () => Promise.reject(new Error('Square asked for a bill'));
  const open = () => ({ staff: noStaff, assertAccess: () => undefined });
  const brief = (e: any) => [e.locationId, e.type, e.amount.toString(), dayOf(e.periodStart), dayOf(e.periodEnd), e.recurringExpenseId, dayOf(e.occurrenceDate), e.teamMemberId];
  const dayOf = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
  const unpaidDue = async (locationId: string, ruleId: string, staff: any = noStaff) =>
    (await service.upcoming({ locationId, today: '2026-11-23', days: 10, staff })).data.filter((o) => o.ruleId === ruleId).map((o) => o.dueDate);

  test('a fixed bill', async () => {
    const centro = await newLocation();
    const renta = await service.createRule(rent(centro, { startDate: '2026-11-01', vendor: 'Don Pepe' }));
    const id = `${renta.id}:2026-11-01`;

    const expenses = await service.pay(id, { date: '2026-11-02', clientRequestId: `pay-${renta.id}` }, open());

    assert({
      given: 'an unpaid rent occurrence paid without an amount',
      should: "book the rule's amount in its store, type and period, linked to the occurrence",
      actual: [expenses.map(brief), expenses[0].vendor],
      expected: [[[centro, 'RENT', '8000', '2026-11-01', '2026-11-30', renta.id, '2026-11-01', null]], 'Don Pepe'],
    });

    assert({
      given: 'the paid occurrence',
      should: 'no longer list it as upcoming, and refuse a second payment (a replay returns the first)',
      actual: [
        await unpaidDue(centro, renta.id),
        await outcome(service.pay(id, { date: '2026-11-03' }, open())),
        (await service.pay(id, { date: '2026-11-02', clientRequestId: `pay-${renta.id}` }, open())).map((e) => e.id),
      ],
      expected: [['2026-12-01'], 'Este pago ya se registró', [expenses[0].id]],
    });
  });

  test('a varying bill and its period', async () => {
    const centro = await newLocation();
    const luz = await service.createRule(rent(centro, { type: 'UTILITIES', name: 'Luz', kind: 'VARIES', amount: null, freq: 'BIMONTHLY', dayOfMonth: 10, startDate: '2026-12-10', periodRule: 'BILL_MONTHS' }));
    const id = `${luz.id}:2026-12-10`;

    assert({
      given: 'a varying bill paid without an amount, with half a period, or on a day it is not due',
      should: 'refuse each',
      actual: [
        await outcome(service.pay(id, { date: '2026-12-10' }, open())),
        await outcome(service.pay(id, { date: '2026-12-10', amount: 1450, periodStart: '2026-10-12' }, open())),
        await outcome(service.pay(`${luz.id}:2026-12-11`, { date: '2026-12-10', amount: 1450 }, open())),
        await outcome(service.pay('nope:2026-12-10', { date: '2026-12-10', amount: 1450 }, open())),
      ],
      expected: ['El monto del gasto debe ser un número mayor que cero', 'El periodo necesita inicio y fin', 'No se encontró la ocurrencia', 'No se encontró la ocurrencia'],
    });

    const [expense] = await service.pay(id, { date: '2026-12-10', amount: 1450, periodStart: '2026-10-12', periodEnd: '2026-12-09' }, open());

    assert({
      given: 'the bill paid with its printed consumption dates',
      should: 'count it in those dates instead of the default months',
      actual: brief(expense),
      expected: [centro, 'UTILITIES', '1450', '2026-10-12', '2026-12-09', luz.id, '2026-12-10', null],
    });
  });

  test('access', async () => {
    const centro = await newLocation();
    const renta = await service.createRule(rent(centro, { startDate: '2026-11-01' }));
    const general = await service.createRule(rent(null, { type: 'PROFESSIONAL', name: 'Contador', startDate: '2026-11-01' }));
    const asked: (string | null)[] = [];
    const deny = { staff: noStaff, assertAccess: (locationId: string | null) => { asked.push(locationId); throw new Error('No tienes acceso a esta sucursal'); } };

    assert({
      given: 'someone without access paying a store bill and a general bill',
      should: 'check the rule store (null: general), refuse, and book nothing',
      actual: [
        await outcome(service.pay(`${renta.id}:2026-11-01`, { date: '2026-11-02' }, deny)),
        await outcome(service.pay(`${general.id}:2026-11-01`, { date: '2026-11-02' }, deny)),
        asked,
        await prisma.expense.count({ where: { recurringExpenseId: { in: [renta.id, general.id] } } }),
      ],
      expected: ['No tienes acceso a esta sucursal', 'No tienes acceso a esta sucursal', [centro, null], 0],
    });
  });

  test('payroll', async () => {
    const centro = await newLocation();
    const norte = await newLocation('Norte');
    const id = (name: string) => `${name}-${centro}`;
    await service.setPayrollConfig([{ teamMemberId: id('beto'), mode: 'FIXED', fixedAmount: 3000, homeLocationId: centro }]);
    const nomina = await service.createRule(rent(centro, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2026-11-21' }));
    const shift = (date: string, locationId: string, workedMinutes: number, cost: number) => ({ date, locationId, workedMinutes, cost });
    const staff = vi.fn().mockResolvedValue([
      { teamMemberId: id('ana'), name: 'Ana', shifts: [shift('2026-11-15', centro, 300, 250.5), shift('2026-11-16', norte, 100, 80)] },
      { teamMemberId: id('beto'), name: 'Beto', shifts: [] },
      { teamMemberId: id('carla'), name: 'Carla', shifts: [shift('2026-11-17', centro, 60, 50), shift('2026-11-18', norte, 180, 150)] },
    ]);
    const occurrence = `${nomina.id}:2026-11-21`;
    const ctx = { staff, assertAccess: vi.fn() };

    assert({
      given: 'a payroll occurrence paid with its own dates, or for someone with no hours here',
      should: 'refuse both',
      actual: [
        await outcome(service.pay(occurrence, { date: '2026-11-21', periodStart: '2026-11-10', periodEnd: '2026-11-20' }, ctx)),
        await outcome(service.pay(occurrence, { date: '2026-11-21', people: [{ teamMemberId: id('zoe') }] }, ctx)),
      ],
      expected: ['La nómina se paga por el periodo de la ocurrencia', 'Sin horas registradas en el periodo'],
    });

    const anaPaid = await service.pay(occurrence, { date: '2026-11-21', people: [{ teamMemberId: id('ana') }] }, ctx);

    assert({
      given: "Ana paid for the 14–20 Nov week at Centro, with Centro's hours amount",
      should: 'book one PAYROLL expense for her at Centro, for that week, linked to the occurrence',
      actual: anaPaid.map(brief),
      expected: [[centro, 'PAYROLL', '250.5', '2026-11-14', '2026-11-20', nomina.id, '2026-11-21', id('ana')]],
    });

    const listed = async () => (await service.upcoming({ locationId: centro, today: '2026-11-23', days: 0, staff })).data
      .filter((o) => o.ruleId === nomina.id).map((o: any) => o.payroll.map((p: any) => p.name));

    assert({
      given: 'the occurrence after paying Ana',
      should: 'no longer list Ana, and refuse paying her again',
      actual: [await listed(), await outcome(service.pay(occurrence, { date: '2026-11-21', people: [{ teamMemberId: id('ana') }] }, ctx))],
      expected: [[['Beto', 'Carla']], 'Ya se le pagó a Ana en esta sucursal por este periodo'],
    });

    ctx.assertAccess.mockClear();
    const rest = await service.pay(occurrence, { date: '2026-11-21', includeOtherStores: true, people: [{ teamMemberId: id('beto') }, { teamMemberId: id('carla'), amount: 400 }] }, ctx);

    assert({
      given: "Beto (fixed) and Carla paid 400 for her hours at both stores (60 min here, 180 at Norte)",
      should: "book Beto's salary here and split Carla's 400 by minutes, Norte's part checked for access",
      actual: [rest.map(brief), ctx.assertAccess.mock.calls],
      expected: [
        [
          [centro, 'PAYROLL', '3000', '2026-11-14', '2026-11-20', nomina.id, '2026-11-21', id('beto')],
          [centro, 'PAYROLL', '100', '2026-11-14', '2026-11-20', nomina.id, '2026-11-21', id('carla')],
          [norte, 'PAYROLL', '300', '2026-11-14', '2026-11-20', nomina.id, '2026-11-21', id('carla')],
        ],
        [[centro], [norte]],
      ],
    });

    assert({
      given: 'everyone paid',
      should: 'drop the occurrence and refuse paying it again',
      actual: [await listed(), await outcome(service.pay(occurrence, { date: '2026-11-21' }, ctx))],
      expected: [[], 'Este pago ya se registró'],
    });
  });

  test('two phones paying the same person at once', async () => {
    const centro = await newLocation();
    const ana = `ana-${centro}`;
    const nomina = await service.createRule(rent(centro, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2026-11-21' }));
    const staff = async () => [{ teamMemberId: ana, name: 'Ana', shifts: [{ date: '2026-11-15', locationId: centro, workedMinutes: 300, cost: 250 }] }];
    const payAna = () => outcome(service.pay(`${nomina.id}:2026-11-21`, { date: '2026-11-21' }, { staff, assertAccess: () => undefined }));

    assert({
      given: 'Ana paid from two phones at the same moment',
      should: 'book her once and refuse the other',
      actual: [(await Promise.all([payAna(), payAna()])).sort(), await prisma.expense.count({ where: { teamMemberId: ana } })],
      expected: [['Este pago ya se registró', 'done'], 1],
    });
  });

  test('a payroll payment replayed while Square is down', async () => {
    const centro = await newLocation();
    const ana = `ana-${centro}`;
    const nomina = await service.createRule(rent(centro, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2026-11-21' }));
    const staff = async () => [{ teamMemberId: ana, name: 'Ana', shifts: [{ date: '2026-11-15', locationId: centro, workedMinutes: 300, cost: 250 }] }];
    const body = { date: '2026-11-21', clientRequestId: `nomina-${centro}` };
    const first = await service.pay(`${nomina.id}:2026-11-21`, body, { staff, assertAccess: () => undefined });

    assert({
      given: 'the same payment sent again (its response was lost) while Square labor fails',
      should: 'return what the first one booked',
      actual: (await service.pay(`${nomina.id}:2026-11-21`, body, { staff: () => Promise.reject(new Error('Square 502')), assertAccess: () => undefined })).map((e) => e.id),
      expected: first.map((e) => e.id),
    });
  });

  test("a replay by someone without access to a store it booked", async () => {
    const centro = await newLocation();
    const norte = await newLocation('Norte');
    const ana = `ana-${centro}`;
    const nomina = await service.createRule(rent(centro, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2026-11-21' }));
    const staff = async () => [{ teamMemberId: ana, name: 'Ana', shifts: [{ date: '2026-11-15', locationId: centro, workedMinutes: 300, cost: 250 }, { date: '2026-11-16', locationId: norte, workedMinutes: 60, cost: 50 }] }];
    const body = { date: '2026-11-21', includeOtherStores: true, clientRequestId: `nomina-${norte}` };
    await service.pay(`${nomina.id}:2026-11-21`, body, { staff, assertAccess: () => undefined });
    const centroOnly = (locationId: string | null) => { if (locationId !== centro) throw new Error('No tienes acceso a esta sucursal'); };

    assert({
      given: "the payment resent by a manager of Centro only, after it booked Ana's Norte hours",
      should: "refuse to return Norte's expense",
      actual: await outcome(service.pay(`${nomina.id}:2026-11-21`, body, { staff, assertAccess: centroOnly })),
      expected: 'No tienes acceso a esta sucursal',
    });
  });

  describe('other stores with their own payday', () => {
    const weekly = (locationId: string, overrides: Record<string, unknown> = {}) => service.createRule(rent(locationId, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2026-11-21', ...overrides }));
    const setup = async () => {
      const centro = await newLocation();
      const norte = await newLocation('Norte');
      const ana = `ana-${centro}`;
      const staff = async () => [{ teamMemberId: ana, name: 'Ana', shifts: [{ date: '2026-11-15', locationId: centro, workedMinutes: 60, cost: 50 }, { date: '2026-11-16', locationId: norte, workedMinutes: 180, cost: 150 }] }];
      const nomina = await weekly(centro);
      const payAna = () => service.pay(`${nomina.id}:2026-11-21`, { date: '2026-11-21', includeOtherStores: true }, { staff, assertAccess: () => undefined });
      return { centro, norte, ana, staff, payAna };
    };

    test('Norte pays on another schedule', async () => {
      const { norte, ana, payAna } = await setup();
      await weekly(norte, { freq: 'BIWEEKLY' }); // 7–20 Nov, not Centro's 14–20

      assert({
        given: "Ana paid from Centro's weekly payroll with her hours at Norte, which pays every two weeks",
        should: 'refuse, naming Norte, and book nothing',
        actual: [await outcome(payAna()), await prisma.expense.count({ where: { teamMemberId: ana } })],
        expected: ['Norte paga nómina con otro periodo; págalo desde Norte', 0],
      });
    });

    test('Norte pays on the same schedule', async () => {
      const { centro, norte, staff, payAna } = await setup();
      const norteNomina = await weekly(norte);

      const booked = await payAna();
      const norteUpcoming = (await service.upcoming({ locationId: norte, today: '2026-11-23', days: 0, staff })).data.filter((o) => o.ruleId === norteNomina.id);

      assert({
        given: "Ana paid from Centro with her hours at Norte, which pays the same week",
        should: "link Norte's part to Norte's own occurrence, so Norte no longer lists her",
        actual: [booked.map((e) => [e.locationId, e.recurringExpenseId, dayOf(e.occurrenceDate)]), norteUpcoming],
        expected: [[[centro, booked[0].recurringExpenseId, '2026-11-21'], [norte, norteNomina.id, '2026-11-21']], []],
      });
    });

    test('Norte already paid her for an overlapping period', async () => {
      const { norte, ana, payAna } = await setup();
      await prisma.expense.create({ data: {
        locationId: norte, type: 'PAYROLL', amount: 150, date: new Date('2026-11-17T18:00:00Z'), teamMemberId: ana,
        periodStart: new Date('2026-11-10T00:00:00Z'), periodEnd: new Date('2026-11-16T00:00:00Z'),
      } });

      assert({
        given: 'Ana paid at Norte for 10–16 Nov, then paid from Centro for 14–20 Nov with other stores',
        should: 'refuse, naming Norte, and book nothing more',
        actual: [await outcome(payAna()), await prisma.expense.count({ where: { teamMemberId: ana } })],
        expected: ['Ya se le pagó a Ana en Norte por un periodo que se cruza', 1],
      });
    });
  });

  test('an empty list of people', async () => {
    const centro = await newLocation();
    const ana = `ana-${centro}`;
    const nomina = await service.createRule(rent(centro, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2026-11-21' }));
    const staff = async () => [{ teamMemberId: ana, name: 'Ana', shifts: [{ date: '2026-11-15', locationId: centro, workedMinutes: 60, cost: 50 }] }];

    const booked = await service.pay(`${nomina.id}:2026-11-21`, { date: '2026-11-21', people: [] }, { staff, assertAccess: () => undefined });

    assert({
      given: 'a payroll paid with people: []',
      should: 'pay everyone owed',
      actual: booked.map((e) => e.teamMemberId),
      expected: [ana],
    });
  });

  test('a one-off payroll payment overlapping the occurrence', async () => {
    const centro = await newLocation();
    const ana = `ana-${centro}`;
    const nomina = await service.createRule(rent(centro, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2026-11-21' }));
    const staff = async () => [
      { teamMemberId: ana, name: 'Ana', shifts: [{ date: '2026-11-15', locationId: centro, workedMinutes: 60, cost: 50 }] },
      { teamMemberId: `beto-${centro}`, name: 'Beto', shifts: [{ date: '2026-11-15', locationId: centro, workedMinutes: 60, cost: 50 }] },
    ];
    // Paid by hand (POST /expenses/payroll) for 10–16 Nov; the occurrence covers 14–20 Nov.
    await prisma.expense.create({ data: {
      locationId: centro, type: 'PAYROLL', amount: 50, date: new Date('2026-11-17T18:00:00Z'), teamMemberId: ana,
      periodStart: new Date('2026-11-10T00:00:00Z'), periodEnd: new Date('2026-11-16T00:00:00Z'),
    } });
    const listed = (await service.upcoming({ locationId: centro, today: '2026-11-23', days: 0, staff })).data
      .filter((o) => o.ruleId === nomina.id).map((o: any) => o.payroll.map((p: any) => p.name));

    assert({
      given: 'Ana paid by hand for a period overlapping the occurrence',
      should: 'not list her as owed, and refuse paying her from it',
      actual: [listed, await outcome(service.pay(`${nomina.id}:2026-11-21`, { date: '2026-11-21', people: [{ teamMemberId: ana }] }, { staff, assertAccess: () => undefined }))],
      expected: [[['Beto']], 'Ya se le pagó a Ana en esta sucursal por este periodo'],
    });
  });
});

describe('RecurringExpenseService autoPay', () => {
  const booked = async (ruleId: string) =>
    (await prisma.expense.findMany({ where: { recurringExpenseId: ruleId }, orderBy: { occurrenceDate: 'asc' } }))
      .map((e) => [e.occurrenceDate!.toISOString().slice(0, 10), e.date.toISOString().slice(0, 10), e.amount.toString()]);

  test('direct-debit bills due up to today', async () => {
    const centro = await newLocation();
    const renta = await service.createRule(rent(centro, { freq: 'WEEKLY', weekday: 1, dayOfMonth: null, startDate: '2026-11-16', autoPaid: true }));
    const manual = await service.createRule(rent(centro, { name: 'Internet', startDate: '2026-11-01' }));
    const paused = await service.createRule(rent(centro, { name: 'Agua', startDate: '2026-11-01', autoPaid: true }));
    await service.updateRule(paused.id, { paused: true } as any);
    await service.pay(`${renta.id}:2026-11-16`, { date: '2026-11-17' }, { staff: () => Promise.resolve([]), assertAccess: () => undefined });

    const mine = (run: { paid: string[]; failed: { occurrenceId: string }[] }) =>
      [run.paid, run.failed.map((f) => f.occurrenceId)].map((ids) => ids.filter((id) => id.startsWith(renta.id)));
    const first = mine(await service.autoPay('2026-11-23'));

    assert({
      given: 'an auto-paid fixed bill with one occurrence already paid by hand',
      should: 'book each other occurrence due up to today, on its due date, for the rule amount',
      actual: await booked(renta.id),
      expected: [['2026-11-16', '2026-11-17', '8000'], ['2026-11-23', '2026-11-23', '8000']],
    });

    assert({
      given: 'a bill that is not auto-paid, and a paused auto-paid bill',
      should: 'book neither',
      actual: [await booked(manual.id), await booked(paused.id)],
      expected: [[], []],
    });

    assert({
      given: 'the run',
      should: 'report the occurrences it booked, and no failures',
      actual: first,
      expected: [[`${renta.id}:2026-11-23`], []],
    });

    const second = mine(await service.autoPay('2026-11-23'));

    assert({
      given: 'the job running again the same day',
      should: 'book nothing twice and not retry what is already paid',
      actual: [(await booked(renta.id)).length, second],
      expected: [2, [[], []]],
    });
  });
  test('old unpaid occurrences of a bill switched to auto-pay', async () => {
    const centro = await newLocation();
    const renta = await service.createRule(rent(centro, { startDate: '2026-06-20', dayOfMonth: 20, autoPaid: true }));

    await service.autoPay('2026-11-23');
    const listed = (await service.upcoming({ locationId: centro, today: '2026-11-23', days: 0, staff: () => Promise.resolve([]) })).data
      .filter((o) => o.ruleId === renta.id).map((o) => [o.dueDate, o.overdue]);

    assert({
      given: 'an auto-paid bill whose start date is months ago',
      should: 'book only the occurrence due in the last week, leaving older ones overdue for a person to settle',
      actual: [await booked(renta.id), listed],
      expected: [
        [['2026-11-20', '2026-11-20', '8000']],
        [['2026-06-20', true], ['2026-07-20', true], ['2026-08-20', true], ['2026-09-20', true], ['2026-10-20', true]],
      ],
    });
  });
});

describe('RecurringExpenseService pending', () => {
  const noPayroll = () => Promise.resolve([]);
  const november = { startDay: '2026-11-01', endDay: '2026-11-30', today: '2026-11-23', staff: noPayroll };
  const brief = (p: any, ruleIds: string[]) => p.items.filter((i: any) => ruleIds.includes(i.ruleId)).map((i: any) => [i.name, i.amount, i.amountIsEstimate]);

  test('the bills of a month not yet recorded', async () => {
    const centro = await newLocation();
    const renta = await service.createRule(rent(centro, { startDate: '2026-11-01' }));
    const internet = await service.createRule(rent(centro, { type: 'UTILITIES', name: 'Internet', amount: 600, dayOfMonth: 15, startDate: '2026-11-15', periodRule: 'PREVIOUS_MONTH' }));
    const luz = await service.createRule(rent(centro, { type: 'UTILITIES', name: 'Luz', kind: 'VARIES', amount: null, startDate: '2026-11-10', dayOfMonth: 10 }));
    const agua = await service.createRule(rent(centro, { type: 'UTILITIES', name: 'Agua', amount: 300, startDate: '2026-11-05', dayOfMonth: 5 }));
    await service.pay(`${agua.id}:2026-11-05`, { date: '2026-11-05' }, { staff: noPayroll, assertAccess: () => undefined });

    const pending = await service.pending({ ...november, locationId: centro });

    assert({
      given: "a store's unpaid November rent, an internet bill due in December for November, a varying bill with no estimate, and a paid bill",
      should: 'list each unpaid one whose period is in the range by due date, total the known amounts, and leave out the paid one and the October internet',
      actual: [brief(pending, [renta.id, internet.id, luz.id, agua.id]), pending!.total, pending!.count],
      expected: [[['Renta', '8000', false], ['Luz', null, true], ['Internet', '600', false]], '8600', 3],
    });
  });

  test('part of a month and the whole business', async () => {
    const centro = await newLocation();
    const renta = await service.createRule(rent(centro, { startDate: '2026-11-01' }));
    const contador = await service.createRule(rent(null, { type: 'OTHER', name: 'Contador', amount: 1500, startDate: '2026-11-01' }));

    const second = await service.pending({ ...november, startDay: '2026-11-16', locationId: centro });
    const business = await service.pending({ ...november, locationId: undefined });
    const store = await service.pending({ ...november, locationId: centro });

    assert({
      given: 'the second half of November',
      should: "count only that half's share of the rent, split by day as a paid one is (spare cents go to the first days)",
      actual: brief(second, [renta.id]),
      expected: [['Renta', '3999.95', false]],
    });

    assert({
      given: 'the whole-business call and the store call',
      should: 'list general bills only in the whole-business one',
      actual: [brief(business, [renta.id, contador.id]), brief(store, [renta.id, contador.id])],
      expected: [[['Contador', '1500', false], ['Renta', '8000', false]], [['Renta', '8000', false]]],
    });
  });

  test('a range that already ended', async () => {
    const centro = await newLocation();
    const renta = await service.createRule(rent(centro, { startDate: '2026-10-01' }));
    const luz = await service.createRule(rent(centro, { type: 'UTILITIES', name: 'Luz', amount: 3000, startDate: '2026-12-05', dayOfMonth: 5, periodRule: 'PREVIOUS_MONTH' }));

    const october = await service.pending({ ...november, startDay: '2026-10-01', endDay: '2026-10-31', locationId: centro });
    const firstDays = await service.pending({ ...november, startDay: '2026-11-01', endDay: '2026-11-20', locationId: centro });
    const longAgo = await service.pending({ ...november, startDay: '2025-01-01', endDay: '2025-01-31', locationId: centro });

    assert({
      given: 'a closed month whose rent was never paid',
      should: 'still list it as pending',
      actual: brief(october, [renta.id, luz.id]),
      expected: [['Renta', '8000', false]],
    });

    assert({
      given: 'a range that ended before today, covered by a bill due next month',
      should: "list that bill's share of the range too",
      actual: brief(firstDays, [renta.id, luz.id]),
      expected: [['Renta', '5333.4', false], ['Luz', '2000', false]], // the first 20 days carry the spare cents: 266.67 each
    });

    assert({
      given: 'a range from before any rule started, over a year ago',
      should: 'have nothing pending',
      actual: [longAgo.count, longAgo.total],
      expected: [0, '0'],
    });
  });
});

describe('RecurringExpenseService payroll weeks', () => {
  // A weekly payroll paid on Saturdays since 14 Nov; Beto has a fixed salary, so every week owes something.
  const weeklyPayroll = async () => {
    const centro = await newLocation();
    const beto = `beto-${centro}`;
    await service.setPayrollConfig([{ teamMemberId: beto, mode: 'FIXED', fixedAmount: 3000, homeLocationId: centro }]);
    const nomina = await service.createRule(rent(centro, { type: 'PAYROLL', name: 'Nómina', kind: 'PAYROLL', amount: null, freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: '2026-11-14' }));
    const staff = vi.fn().mockResolvedValue([{ teamMemberId: beto, name: 'Beto', shifts: [] }]);
    return { centro, beto, nomina, staff };
  };
  const payrollPaid = (locationId: string, start: string, end: string) => prisma.expense.create({ data: {
    locationId, type: 'PAYROLL', amount: 500, date: new Date(`${end}T18:00:00Z`),
    periodStart: new Date(`${start}T00:00:00Z`), periodEnd: new Date(`${end}T00:00:00Z`),
  } });

  test('weeks that have not started', async () => {
    const { centro, staff } = await weeklyPayroll();

    const { data } = await service.upcoming({ locationId: centro, today: '2026-11-23', days: 30, staff });

    assert({
      given: 'a month of upcoming payroll, today Monday 23 Nov',
      should: 'list the overdue week and the week in progress, not the weeks that have not started',
      actual: data.map((o: any) => [o.dueDate, o.periodStart, o.periodEnd]),
      expected: [['2026-11-14', '2026-11-07', '2026-11-13'], ['2026-11-21', '2026-11-14', '2026-11-20'], ['2026-11-28', '2026-11-21', '2026-11-27']],
    });

    const { data: onPayday } = await service.upcoming({ locationId: centro, today: '2026-11-21', days: 30, staff });
    assert({
      given: 'today a payday, when the next week starts',
      should: 'list that week as in progress',
      actual: onPayday.map((o: any) => o.dueDate),
      expected: ['2026-11-14', '2026-11-21', '2026-11-28'],
    });
  });

  test('Square down, with weeks that already have payments', async () => {
    const { centro, nomina } = await weeklyPayroll();
    const norte = await newLocation('Norte');
    await payrollPaid(centro, '2026-11-07', '2026-11-13');
    await payrollPaid(norte, '2026-11-14', '2026-11-20');

    const { data } = await service.upcoming({ locationId: centro, today: '2026-11-23', days: 6, staff: () => Promise.reject(new Error('Square 502')) });

    assert({
      given: 'a week with a payroll payment at this store, a week paid only at another store, and the week in progress',
      should: 'keep listing every week, and say which one already has payments here',
      actual: data.filter((o: any) => o.ruleId === nomina.id).map((o: any) => [o.dueDate, o.amount, o.hasPayments]),
      expected: [['2026-11-14', null, true], ['2026-11-21', null, false], ['2026-11-28', null, false]],
    });
  });

  test('Square answering', async () => {
    const { centro, staff } = await weeklyPayroll();

    const { data } = await service.upcoming({ locationId: centro, today: '2026-11-23', days: 6, staff });

    assert({
      given: 'Square answering',
      should: 'not send hasPayments',
      actual: data.map((o: any) => 'hasPayments' in o),
      expected: [false, false, false],
    });
  });

  test('the P&L of the current month', async () => {
    const { centro, nomina, staff } = await weeklyPayroll();
    const today = '2026-11-27'; // Friday: the next payroll week starts tomorrow

    const pending = await service.pending({ locationId: centro, startDay: '2026-11-01', endDay: '2026-11-30', today, staff });
    const { data: upcoming } = await service.upcoming({ locationId: centro, today, days: 30, staff });

    assert({
      given: "November's pending bills, with Beto's fixed salary for a week that starts tomorrow",
      should: "count that week's November days, as a bill due later in the month is",
      actual: pending.items.filter((i: any) => i.ruleId === nomina.id).map((i: any) => [i.dueDate, i.amount]),
      expected: [['2026-11-14', '3000'], ['2026-11-21', '3000'], ['2026-11-28', '3000'], ['2026-12-05', '1285.71']], // 3 of 7 days; split by month first, December's larger remainder takes the spare cent
    });

    assert({
      given: 'the same day',
      should: 'leave that week out of the upcoming list',
      actual: upcoming.map((o: any) => o.dueDate),
      expected: ['2026-11-14', '2026-11-21', '2026-11-28'],
    });
  });

  test('paying a week before it ends', async () => {
    const { nomina, staff } = await weeklyPayroll();
    const ctx = (today: string) => ({ staff, assertAccess: () => undefined, today });

    assert({
      given: 'the week in progress, paid early in the week and on its last day',
      should: 'refuse both',
      actual: [
        await outcome(service.pay(`${nomina.id}:2026-11-28`, { date: '2026-11-23' }, ctx('2026-11-23'))),
        await outcome(service.pay(`${nomina.id}:2026-11-28`, { date: '2026-11-27' }, ctx('2026-11-27'))),
      ],
      expected: ['La semana todavía no termina', 'La semana todavía no termina'],
    });

    assert({
      given: 'the same week, paid on its payday',
      should: 'book it',
      actual: (await service.pay(`${nomina.id}:2026-11-28`, { date: '2026-11-28' }, ctx('2026-11-28'))).map((e) => e.amount.toString()),
      expected: ['3000'],
    });
  });
});
