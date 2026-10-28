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
