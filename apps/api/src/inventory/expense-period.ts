import { Prisma } from '@prisma/client';
import { businessDay } from './business-date';

/**
 * An expense counts in the period it covers (periodStart–periodEnd, store days,
 * inclusive), not on the day it was paid; with no period, on the day paid. The
 * stored expense stays whole; reports take each range's share:
 * - PAYROLL: spread evenly over the days of the period.
 * - Anything else: each month weighs the part of it the period covers (a whole
 *   month weighs 1, so a two-month bill is half and half), spread over its days.
 * Shares are whole cents that add up exactly to the amount.
 */
export interface PeriodExpense {
  type: string;
  amount: Prisma.Decimal | number;
  date: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
}

const DAY_MS = 86_400_000;
// lcm(28, 29, 30, 31): month weights stay whole numbers.
const MONTH_UNIT = 377_580n;

const dayOf = (date: Date) => date.toISOString().slice(0, 10); // @db.Date comes back as UTC midnight
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const daysInMonth = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();

/** The store days an expense covers. */
export function expensePeriod(expense: PeriodExpense): { start: string; end: string } {
  if (expense.periodStart && expense.periodEnd) return { start: dayOf(expense.periodStart), end: dayOf(expense.periodEnd) };
  const paid = businessDay(expense.date);
  return { start: paid, end: paid };
}

/** Largest-remainder split of `total` by `weights`; ties go to the earlier part. */
export function split(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  const parts = weights.map((w) => (total * w) / sum);
  let left = total - parts.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, rest: (total * w) % sum }))
    .sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.i - b.i));
  for (const { i } of order) {
    if (left === 0n) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return parts;
}

/** Each covered day with its cents. */
function dailyCents(expense: PeriodExpense): Array<[string, bigint]> {
  const { start, end } = expensePeriod(expense);
  const months = new Map<string, string[]>();
  for (let day = start; day <= end; day = nextDay(day)) {
    const month = day.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), day]);
  }
  const entries = [...months.entries()];
  const weights = entries.map(([month, days]) =>
    expense.type === 'PAYROLL' ? BigInt(days.length) : (BigInt(days.length) * MONTH_UNIT) / BigInt(daysInMonth(month)),
  );
  const cents = BigInt(new Prisma.Decimal(expense.amount).mul(100).toFixed(0));
  const monthCents = split(cents, weights);
  return entries.flatMap(([, days], m) => {
    const dayCents = split(monthCents[m], days.map(() => 1n));
    return days.map((day, d): [string, bigint] => [day, dayCents[d]]);
  });
}

const inRange = (day: string, startDay?: string, endDay?: string) => (!startDay || day >= startDay) && (!endDay || day <= endDay);
const toAmount = (cents: bigint) => new Prisma.Decimal(cents.toString()).div(100);

/** The part of an expense that falls in [startDay, endDay] (store days, YYYY-MM-DD; open when omitted). */
export function expenseShare(expense: PeriodExpense, startDay?: string, endDay?: string): string {
  return expenseShareDecimal(expense, startDay, endDay).toString();
}

export function expenseShareDecimal(expense: PeriodExpense, startDay?: string, endDay?: string): Prisma.Decimal {
  const cents = dailyCents(expense).reduce((sum, [day, c]) => (inRange(day, startDay, endDay) ? sum + c : sum), 0n);
  return toAmount(cents);
}

/** The expense's share per month (YYYY-MM) inside the range, months with no share left out. */
export function expenseSharesByMonth(expense: PeriodExpense, startDay?: string, endDay?: string): Array<[string, string]> {
  const byMonth = new Map<string, bigint>();
  for (const [day, c] of dailyCents(expense)) {
    if (inRange(day, startDay, endDay)) byMonth.set(day.slice(0, 7), (byMonth.get(day.slice(0, 7)) ?? 0n) + c);
  }
  return [...byMonth.entries()].filter(([, c]) => c > 0n).map(([month, c]) => [month, toAmount(c).toString()]);
}

/**
 * Expenses whose period overlaps the range. `startDate`/`endDate` are report
 * instants; they're compared as store days.
 */
export function expensePeriodOverlaps(startDate?: Date, endDate?: Date): Prisma.ExpenseWhereInput {
  if (!startDate && !endDate) return {};
  const startDay = startDate && businessDay(startDate);
  const endDay = endDate && businessDay(endDate);
  const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
  return {
    OR: [
      { periodStart: null, date: { ...(startDate && { gte: startDate }), ...(endDate && { lte: endDate }) } },
      { periodStart: { not: null, ...(endDay && { lte: asDate(endDay) }) }, periodEnd: { not: null, ...(startDay && { gte: asDate(startDay) }) } },
    ],
  };
}

/** The store days of a report range, for expenseShare. */
export function reportDays(startDate?: Date, endDate?: Date): [string | undefined, string | undefined] {
  return [startDate && businessDay(startDate), endDate && businessDay(endDate)];
}
