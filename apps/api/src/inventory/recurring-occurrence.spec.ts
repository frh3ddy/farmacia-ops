import { assert } from 'riteway/vitest';
import { dueDates, occurrencePeriod } from './recurring-occurrence';

/** A rule as stored; override any field. */
const rule = (overrides: Record<string, unknown>) => ({
  kind: 'FIXED', freq: 'MONTHLY', dayOfMonth: 1, weekday: null,
  startDate: new Date('2026-12-01T00:00:00Z'), periodRule: 'DUE_MONTH', ...overrides,
}) as any; // fixture: only the fields the generator reads

const start = (day: string) => new Date(`${day}T00:00:00Z`);

describe('dueDates', () => {
  test('monthly rules', () => {
    assert({
      given: 'a monthly rule on the 31st',
      should: "clamp each due date to the month's end",
      actual: dueDates(rule({ dayOfMonth: 31, startDate: start('2027-01-31') }), '2027-04-30'),
      expected: ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'],
    });

    assert({
      given: 'a monthly rule on the 1st starting on the 20th',
      should: 'start at the first due date on or after startDate',
      actual: dueDates(rule({ dayOfMonth: 1, startDate: start('2026-11-20') }), '2027-01-15'),
      expected: ['2026-12-01', '2027-01-01'],
    });

    assert({
      given: 'a horizon before the start date',
      should: 'give no due dates',
      actual: dueDates(rule({}), '2026-11-30'),
      expected: [],
    });
  });

  test('bimonthly and yearly rules', () => {
    assert({
      given: 'a bimonthly rule on the 15th from December',
      should: 'fall every second month',
      actual: dueDates(rule({ freq: 'BIMONTHLY', dayOfMonth: 15, startDate: start('2026-12-15') }), '2027-05-01'),
      expected: ['2026-12-15', '2027-02-15', '2027-04-15'],
    });

    assert({
      given: 'a yearly rule on 29 February',
      should: 'fall on the 28th in other years',
      actual: dueDates(rule({ freq: 'YEARLY', dayOfMonth: 29, startDate: start('2028-02-29') }), '2030-03-01'),
      expected: ['2028-02-29', '2029-02-28', '2030-02-28'],
    });
  });

  test('weekly and biweekly rules', () => {
    assert({
      given: 'a weekly rule on Saturdays starting on a Monday',
      should: 'fall on each Saturday from that week',
      actual: dueDates(rule({ freq: 'WEEKLY', dayOfMonth: null, weekday: 6, startDate: start('2026-11-23') }), '2026-12-12'),
      expected: ['2026-11-28', '2026-12-05', '2026-12-12'],
    });

    assert({
      given: 'a biweekly rule on Mondays starting on a Monday',
      should: 'fall every other Monday from startDate',
      actual: dueDates(rule({ freq: 'BIWEEKLY', dayOfMonth: null, weekday: 1, startDate: start('2026-11-23') }), '2026-12-21'),
      expected: ['2026-11-23', '2026-12-07', '2026-12-21'],
    });
  });
});

describe('occurrencePeriod', () => {
  test('month rules', () => {
    assert({
      given: 'DUE_MONTH, due 1 December',
      should: 'count in December',
      actual: occurrencePeriod(rule({}), '2026-12-01'),
      expected: { start: '2026-12-01', end: '2026-12-31' },
    });

    assert({
      given: 'PREVIOUS_MONTH, due 1 December',
      should: 'count in November',
      actual: occurrencePeriod(rule({ periodRule: 'PREVIOUS_MONTH' }), '2026-12-01'),
      expected: { start: '2026-11-01', end: '2026-11-30' },
    });
  });

  test("a bill's months", () => {
    assert({
      given: 'a bimonthly bill due in December',
      should: 'cover October–November',
      actual: occurrencePeriod(rule({ freq: 'BIMONTHLY', periodRule: 'BILL_MONTHS', dayOfMonth: 15 }), '2026-12-15'),
      expected: { start: '2026-10-01', end: '2026-11-30' },
    });

    assert({
      given: 'a yearly bill due in March',
      should: 'cover the twelve months before March',
      actual: occurrencePeriod(rule({ freq: 'YEARLY', periodRule: 'BILL_MONTHS' }), '2027-03-01'),
      expected: { start: '2026-03-01', end: '2027-02-28' },
    });

    assert({
      given: 'a weekly bill',
      should: 'cover the days since the previous due date',
      actual: occurrencePeriod(rule({ freq: 'WEEKLY', periodRule: 'BILL_MONTHS', dayOfMonth: null, weekday: 6 }), '2026-12-05'),
      expected: { start: '2026-11-28', end: '2026-12-04' },
    });
  });

  test('payroll', () => {
    assert({
      given: 'a weekly payroll due Saturday 28 November (periodRule set to DUE_MONTH)',
      should: 'cover the 7 days before it',
      actual: occurrencePeriod(rule({ kind: 'PAYROLL', freq: 'WEEKLY', dayOfMonth: null, weekday: 6 }), '2026-11-28'),
      expected: { start: '2026-11-21', end: '2026-11-27' },
    });

    assert({
      given: 'a biweekly payroll due 7 December',
      should: 'cover the 14 days before it',
      actual: occurrencePeriod(rule({ kind: 'PAYROLL', freq: 'BIWEEKLY', dayOfMonth: null, weekday: 1 }), '2026-12-07'),
      expected: { start: '2026-11-23', end: '2026-12-06' },
    });

    assert({
      given: 'a monthly payroll on the 31st due 31 March',
      should: 'run from the previous due date (28 Feb) to the day before',
      actual: occurrencePeriod(rule({ kind: 'PAYROLL', dayOfMonth: 31 }), '2027-03-31'),
      expected: { start: '2027-02-28', end: '2027-03-30' },
    });
  });
});
