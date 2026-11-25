import { RecurringExpense } from '@prisma/client';

/**
 * When a recurring rule falls due and which store days each payment counts in.
 * Days are YYYY-MM-DD store days; nothing here reads the clock or the database.
 */
export type OccurrenceRule = Pick<RecurringExpense, 'kind' | 'freq' | 'dayOfMonth' | 'weekday' | 'startDate' | 'periodRule'>;

const DAY_MS = 86_400_000;
const MONTH_STEP: Record<string, number> = { MONTHLY: 1, BIMONTHLY: 2, YEARLY: 12 };
const WEEK_STEP: Record<string, number> = { WEEKLY: 7, BIWEEKLY: 14 };

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
/** Day `dom` of the month `n` months after `day`'s, clamped to that month's end. */
const inMonth = (day: string, n: number, dom: number) => {
  const year = +day.slice(0, 4);
  const month = +day.slice(5, 7) - 1 + n;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return dayOf(new Date(Date.UTC(year, month, Math.min(dom, last))));
};
const monthEnd = (day: string) => inMonth(day, 0, 31);

/** The due date one step before `due`. */
function previousDue(rule: OccurrenceRule, due: string): string {
  return rule.freq in WEEK_STEP ? addDays(due, -WEEK_STEP[rule.freq]) : inMonth(due, -MONTH_STEP[rule.freq], rule.dayOfMonth!);
}

/** Every due date from startDate through `until`. */
export function dueDates(rule: OccurrenceRule, until: string): string[] {
  const start = dayOf(rule.startDate);
  const days: string[] = [];
  if (rule.freq in WEEK_STEP) {
    const first = addDays(start, (rule.weekday! - rule.startDate.getUTCDay() + 7) % 7);
    for (let due = first; due <= until; due = addDays(due, WEEK_STEP[rule.freq])) days.push(due);
    return days;
  }
  // Month steps count from startDate's month, so a long month never shifts the next one.
  for (let k = 0; ; k += MONTH_STEP[rule.freq]) {
    const due = inMonth(start, k, rule.dayOfMonth!);
    if (due > until) return days;
    if (due >= start) days.push(due);
  }
}

/**
 * The store days a payment due on `due` counts in:
 * - PAYROLL (periodRule ignored), or a weekly bill: since the previous due date, up to the day before.
 * - DUE_MONTH: the due date's month. PREVIOUS_MONTH: the month before.
 * - BILL_MONTHS: the months the frequency spans, before the due month.
 */
export function occurrencePeriod(rule: OccurrenceRule, due: string): { start: string; end: string } {
  if (rule.kind === 'PAYROLL' || (rule.periodRule === 'BILL_MONTHS' && rule.freq in WEEK_STEP)) {
    return { start: previousDue(rule, due), end: addDays(due, -1) };
  }
  if (rule.periodRule === 'DUE_MONTH') return { start: inMonth(due, 0, 1), end: monthEnd(due) };
  const months = rule.periodRule === 'BILL_MONTHS' ? MONTH_STEP[rule.freq] : 1;
  return { start: inMonth(due, -months, 1), end: monthEnd(inMonth(due, -1, 1)) };
}
