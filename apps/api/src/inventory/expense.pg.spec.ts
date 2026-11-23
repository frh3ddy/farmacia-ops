/**
 * Expenses against a real Postgres engine (see testing/pglite.ts): what a
 * client may send, and offline-queue replays.
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseService } from './expense.service';

let prisma: PrismaService;
let stop: () => Promise<void>;
let service: ExpenseService;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  service = new ExpenseService(prisma);
}, 120_000);

afterAll(() => stop?.());

const newLocation = async (name = 'Centro') =>
  (await prisma.location.create({ data: { squareId: `SQ-${Math.random()}`, name } })).id;

/** 'done', or the refusal's message. */
const outcome = (promise: Promise<unknown>) => promise.then(() => 'done', (e: Error) => e.message);

const invalidAmountMessage = 'El monto del gasto debe ser un número mayor que cero';

describe('ExpenseService amount', () => {
  test('creating with an amount that is not a positive number', async () => {
    const locationId = await newLocation();
    const date = new Date('2026-10-01');

    const outcomes = [];
    for (const amount of [-500, 0, Number.NaN, '500' as any]) {
      outcomes.push(await outcome(service.createExpense({ locationId, type: 'RENT', amount, date })));
    }

    assert({
      given: 'a negative, zero, NaN or string amount',
      should: 'refuse each and record nothing (a negative expense would raise net profit)',
      actual: [outcomes, await prisma.expense.count({ where: { locationId } })],
      expected: [Array(4).fill(invalidAmountMessage), 0],
    });
  });

  test('editing the amount', async () => {
    const locationId = await newLocation();
    const { id } = await service.createExpense({ locationId, type: 'RENT', amount: 500, date: new Date('2026-10-01') });

    assert({
      given: 'an edit to a negative amount, then to a positive one',
      should: 'refuse the negative and keep the positive',
      actual: [
        await outcome(service.updateExpense(id, { amount: -500 })),
        await outcome(service.updateExpense(id, { amount: 600 })),
        (await prisma.expense.findUniqueOrThrow({ where: { id } })).amount.toString(),
      ],
      expected: [invalidAmountMessage, 'done', '600'],
    });
  });
});

describe('ExpenseService request ids', () => {
  test('a request id already used for a different expense', async () => {
    const locationId = await newLocation();
    const norte = await newLocation('Norte');
    const clientRequestId = `req-reused-${locationId}`;
    const request = { locationId, type: 'RENT' as const, amount: 500, date: new Date('2026-10-01'), clientRequestId };
    await service.createExpense(request);

    const outcomes = [];
    for (const attempt of [{ locationId: norte }, { type: 'UTILITIES' as const }, { amount: 501 }]) {
      outcomes.push(await outcome(service.createExpense({ ...request, ...attempt })));
    }

    assert({
      given: 'the request id resent from another location, with another type, or with another amount',
      should: 'refuse each instead of returning the original expense',
      actual: outcomes,
      expected: Array(3).fill('This clientRequestId was already used for a different expense'),
    });
  });

  test('the same replay arriving twice at once', async () => {
    const locationId = await newLocation();
    const request = { locationId, type: 'RENT' as const, amount: 500, date: new Date('2026-10-01'), clientRequestId: `req-race-${locationId}` };

    const [first, second] = await Promise.all([service.createExpense(request), service.createExpense(request)]);

    assert({
      given: 'two copies of one offline-queue replay racing',
      should: 'record the expense once and return it to both',
      actual: [second.id === first.id, await prisma.expense.count({ where: { locationId } })],
      expected: [true, 1],
    });
  });
});

describe('ExpenseService period', () => {
  test('a period with one end, or ending before it starts', async () => {
    const locationId = await newLocation();
    const base = { locationId, type: 'RENT' as const, amount: 500, date: new Date('2026-11-28T12:00:00-06:00') };

    assert({
      given: 'only a start, only an end, or an end before the start',
      should: 'refuse each and record nothing',
      actual: [
        await outcome(service.createExpense({ ...base, periodStart: '2026-12-01' })),
        await outcome(service.createExpense({ ...base, periodEnd: '2026-12-31' })),
        await outcome(service.createExpense({ ...base, periodStart: '2026-12-31', periodEnd: '2026-12-01' })),
        await outcome(service.createExpense({ ...base, periodStart: 'diciembre', periodEnd: '2026-12-31' })),
        await prisma.expense.count({ where: { locationId } }),
      ],
      expected: [
        'El periodo necesita inicio y fin',
        'El periodo necesita inicio y fin',
        'El fin del periodo no puede ser antes del inicio',
        'El periodo debe tener fechas AAAA-MM-DD',
        0,
      ],
    });
  });

  test('rent paid in November for December', async () => {
    const locationId = await newLocation();
    await service.createExpense({
      locationId, type: 'RENT', amount: 8000, date: new Date('2026-11-28T12:00:00-06:00'),
      periodStart: '2026-12-01', periodEnd: '2026-12-31',
    });
    const november = { locationId, startDate: new Date('2026-11-01T00:00:00-06:00'), endDate: new Date('2026-11-30T23:59:59.999-06:00') };
    const december = { locationId, startDate: new Date('2026-12-01T00:00:00-06:00'), endDate: new Date('2026-12-31T23:59:59.999-06:00') };

    assert({
      given: 'rent paid on 28 November for December',
      should: 'list and total it in December, not November',
      actual: [
        (await service.listExpenses(november)).length,
        (await service.listExpenses(december)).length,
        (await service.getExpenseSummary(november)).totals.totalExpenses,
        (await service.getExpenseSummary(december)).totals.totalExpenses,
      ],
      expected: [0, 1, '0', '8000'],
    });
  });

  test('a payroll week across two months, by month', async () => {
    const locationId = await newLocation();
    await service.createExpense({
      locationId, type: 'PAYROLL', amount: 700, date: new Date('2026-12-07T12:00:00-06:00'),
      periodStart: '2026-11-30', periodEnd: '2026-12-06',
    });

    const summary = await service.getExpenseSummary({ locationId, includeMonthly: true });

    assert({
      given: 'a payroll week from 30 November to 6 December',
      should: 'put one day in November and six in December',
      actual: summary.byMonth,
      expected: [{ month: '2026-11', total: '100', count: 1 }, { month: '2026-12', total: '600', count: 1 }],
    });
  });
});

describe('ExpenseService general expenses', () => {
  test('an expense with no store', async () => {
    const locationId = await newLocation();
    const date = new Date('2026-11-10T12:00:00-06:00');
    await service.createExpense({ locationId, type: 'RENT', amount: 500, date });
    const general = await service.createExpense({ locationId: null, type: 'PROFESSIONAL', amount: 1200, date, clientRequestId: `gen-${locationId}` });

    assert({
      given: 'a store expense and a general one',
      should: 'keep the general one out of the store and list it under general',
      actual: [
        general.locationId,
        (await service.listExpenses({ locationId })).map((e) => e.type),
        (await service.listExpenses({ locationId: null })).some((e) => e.id === general.id),
        (await service.listExpenses({ locationId: null })).every((e) => e.locationId === null),
      ],
      expected: [null, ['RENT'], true, true],
    });
  });
});

describe('ExpenseService payroll by store', () => {
  const payroll = (stores: { locationId: string; workedMinutes: number }[], extra: Record<string, unknown> = {}) => ({
    teamMemberId: `TM-${Math.random()}`, periodStart: '2026-11-30', periodEnd: '2026-12-06',
    amount: 1000, date: new Date('2026-12-07T12:00:00-06:00'), hours: async () => stores, ...extra,
  });

  test('a person who worked at two stores', async () => {
    const centro = await newLocation();
    const norte = await newLocation('Norte');
    const input = payroll([{ locationId: centro, workedMinutes: 120 }, { locationId: norte, workedMinutes: 60 }]);

    const expenses = await service.createPayrollExpenses(input);

    assert({
      given: 'a $1,000 payment and twice the hours at one store as at the other',
      should: 'record one payroll expense per store by hours, with cents adding up to the payment',
      actual: expenses.map((e) => [e.locationId === centro ? 'centro' : 'norte', e.amount.toString(), e.type, e.teamMemberId, e.periodStart?.toISOString().slice(0, 10), e.periodEnd?.toISOString().slice(0, 10)]),
      expected: [
        ['centro', '666.67', 'PAYROLL', input.teamMemberId, '2026-11-30', '2026-12-06'],
        ['norte', '333.33', 'PAYROLL', input.teamMemberId, '2026-11-30', '2026-12-06'],
      ],
    });
  });

  test('no hours in the period', async () => {
    const centro = await newLocation();

    assert({
      given: 'no hours at any store, or only zero-minute shifts',
      should: 'refuse and record nothing',
      actual: [
        await outcome(service.createPayrollExpenses(payroll([]))),
        await outcome(service.createPayrollExpenses(payroll([{ locationId: centro, workedMinutes: 0 }]))),
        await prisma.expense.count({ where: { locationId: centro } }),
      ],
      expected: ['Sin horas registradas en el periodo', 'Sin horas registradas en el periodo', 0],
    });
  });

  test('a payment with no period', async () => {
    const centro = await newLocation();

    assert({
      given: 'a payroll payment missing the end of its period',
      should: 'refuse it',
      actual: await outcome(service.createPayrollExpenses(payroll([{ locationId: centro, workedMinutes: 60 }], { periodEnd: undefined }))),
      expected: 'El periodo necesita inicio y fin',
    });
  });

  test('the same payment replayed', async () => {
    const centro = await newLocation();
    const norte = await newLocation('Norte');
    const input = payroll([{ locationId: centro, workedMinutes: 60 }, { locationId: norte, workedMinutes: 60 }], { clientRequestId: `pay-${centro}` });

    const first = await service.createPayrollExpenses(input);
    const [second, third] = await Promise.all([service.createPayrollExpenses(input), service.createPayrollExpenses(input)]);

    assert({
      given: 'an offline-queue replay of a payroll payment, twice at once',
      should: 'record the expenses once and return the same ones',
      actual: [
        second.map((e) => e.id).sort(),
        third.map((e) => e.id).sort(),
        await prisma.expense.count({ where: { teamMemberId: input.teamMemberId } }),
      ],
      expected: [first.map((e) => e.id).sort(), first.map((e) => e.id).sort(), 2],
    });
  });

  test('a replay after the hours changed in Square', async () => {
    const centro = await newLocation();
    const norte = await newLocation('Norte');
    const input = payroll([{ locationId: centro, workedMinutes: 60 }], { clientRequestId: `pay-moved-${centro}` });
    const first = await service.createPayrollExpenses(input);
    let asked = 0;

    const onlyNorte = await service.createPayrollExpenses({ ...input, hours: async () => { asked++; return [{ locationId: norte, workedMinutes: 60 }]; } });
    const squareDown = await outcome(service.createPayrollExpenses({ ...input, hours: async () => { asked++; throw new Error('Square down'); } }));

    assert({
      given: 'the payment replayed after its hours moved to another store, and again with Square down',
      should: 'return the original expenses both times without asking Square, and pay nothing twice',
      actual: [
        onlyNorte.map((e) => e.id),
        squareDown,
        asked,
        await prisma.expense.count({ where: { teamMemberId: input.teamMemberId } }),
      ],
      expected: [first.map((e) => e.id), 'done', 0, 1],
    });
  });

  test('a request id reused for a different payment', async () => {
    const centro = await newLocation();
    const input = payroll([{ locationId: centro, workedMinutes: 60 }], { clientRequestId: `pay-reused-${centro}` });
    await service.createPayrollExpenses(input);

    assert({
      given: 'the same request id with another amount, or for another person',
      should: 'refuse instead of returning the original payment',
      actual: [
        await outcome(service.createPayrollExpenses({ ...input, amount: 999 })),
        await outcome(service.createPayrollExpenses({ ...input, teamMemberId: 'someone-else' })),
      ],
      expected: Array(2).fill('This clientRequestId was already used for a different expense'),
    });
  });
});
