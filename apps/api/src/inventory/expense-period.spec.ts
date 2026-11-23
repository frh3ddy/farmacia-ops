import { assert } from 'riteway/vitest';
import { expenseShare, expenseSharesByMonth } from './expense-period';

/** An expense as stored: periodStart/periodEnd are @db.Date (UTC midnight), date is the payment instant. */
const expense = (overrides: { type?: string; amount?: number; date?: string; periodStart?: string; periodEnd?: string } = {}) => ({
  type: overrides.type ?? 'UTILITIES',
  amount: overrides.amount ?? 100,
  date: new Date(overrides.date ?? '2026-11-28T12:00:00-06:00'),
  periodStart: overrides.periodStart ? new Date(`${overrides.periodStart}T00:00:00Z`) : null,
  periodEnd: overrides.periodEnd ? new Date(`${overrides.periodEnd}T00:00:00Z`) : null,
});

describe('expenseShare', () => {
  test('an expense with no period', () => {
    const late = expense({ date: '2026-11-30T22:00:00-06:00' });
    assert({
      given: 'no period, paid late at night on the last day of the month (store clock)',
      should: 'count whole on the store day it was paid, not the next UTC day',
      actual: [expenseShare(late, '2026-11-01', '2026-11-30'), expenseShare(late, '2026-12-01', '2026-12-31')],
      expected: ['100', '0'],
    });
  });

  test('rent paid in one month for the next', () => {
    const rent = expense({ type: 'RENT', amount: 8000, date: '2026-11-28T12:00:00-06:00', periodStart: '2026-12-01', periodEnd: '2026-12-31' });
    assert({
      given: 'rent paid in November for December',
      should: 'count in December, not in the month it was paid',
      actual: [expenseShare(rent, '2026-11-01', '2026-11-30'), expenseShare(rent, '2026-12-01', '2026-12-31')],
      expected: ['0', '8000'],
    });
  });

  test('a bill covering two whole months', () => {
    const bill = expense({ amount: 1000, periodStart: '2026-10-01', periodEnd: '2026-11-30' });
    assert({
      given: 'a bimonthly bill for October (31 days) and November (30 days)',
      should: 'give each month half, not a share by days',
      actual: [expenseShare(bill, '2026-10-01', '2026-10-31'), expenseShare(bill, '2026-11-01', '2026-11-30')],
      expected: ['500', '500'],
    });
  });

  test('a payroll week across two months', () => {
    const payroll = expense({ type: 'PAYROLL', amount: 700, periodStart: '2026-11-30', periodEnd: '2026-12-06' });
    assert({
      given: 'a payroll week from 30 November to 6 December',
      should: 'split it by days: one day in November, six in December',
      actual: [expenseShare(payroll, '2026-11-01', '2026-11-30'), expenseShare(payroll, '2026-12-01', '2026-12-31')],
      expected: ['100', '600'],
    });
  });

  test('cents that do not divide evenly', () => {
    const bill = expense({ amount: 100, periodStart: '2026-10-01', periodEnd: '2026-12-31' });
    const months = [['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-30'], ['2026-12-01', '2026-12-31']] as const;
    const shares = months.map(([start, end]) => expenseShare(bill, start, end));
    assert({
      given: 'a $100 bill over three months',
      should: 'give whole cents that add up exactly to the amount',
      actual: [shares, shares.reduce((sum, s) => sum + Math.round(Number(s) * 100), 0)],
      expected: [['33.34', '33.33', '33.33'], 10000],
    });
  });

  test('a report range that is not a whole month', () => {
    const bill = expense({ amount: 3000, periodStart: '2026-11-01', periodEnd: '2026-11-30' });
    assert({
      given: 'a November bill and a report for the first ten days of November',
      should: 'count ten of its thirty days',
      actual: expenseShare(bill, '2026-11-01', '2026-11-10'),
      expected: '1000',
    });
  });

  test('a bill period that does not start on the 1st', () => {
    const bill = expense({ amount: 1000, periodStart: '2026-10-17', periodEnd: '2026-12-16' });
    const parts = [['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-30'], ['2026-12-01', '2026-12-31']].map(([s, e]) => Number(expenseShare(bill, s, e)));
    assert({
      given: 'a bill from 17 October to 16 December',
      should: 'weigh each month by the part of it covered, adding up to the amount',
      actual: [parts[1] > parts[0] && parts[1] > parts[2], Math.round(parts.reduce((a, b) => a + b) * 100)],
      expected: [true, 100000],
    });
  });

  test('an open-ended report range', () => {
    const bill = expense({ amount: 1000, periodStart: '2026-10-01', periodEnd: '2026-11-30' });
    assert({
      given: 'no start, no end, or neither',
      should: 'count every day on the open side',
      actual: [expenseShare(bill, undefined, '2026-10-31'), expenseShare(bill, '2026-11-01', undefined), expenseShare(bill)],
      expected: ['500', '500', '1000'],
    });
  });
});

describe('expenseSharesByMonth', () => {
  test('a bill across months, reported by month', () => {
    const payroll = expense({ type: 'PAYROLL', amount: 700, periodStart: '2026-11-30', periodEnd: '2026-12-06' });
    assert({
      given: 'a payroll week across November and December, and a range ending 3 December',
      should: 'list each month with its share inside the range',
      actual: expenseSharesByMonth(payroll, '2026-11-01', '2026-12-03'),
      expected: [['2026-11', '100'], ['2026-12', '300']],
    });
  });
});
