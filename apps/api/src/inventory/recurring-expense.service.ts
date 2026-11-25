import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ExpenseType, PayrollMode, Prisma, RecurringExpense, RecurringExpenseKind, RecurringFrequency, RecurringPeriodRule,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, dueDates, occurrencePeriod } from './recurring-occurrence';
import { assertAmount, periodData } from './expense.service';
import { split } from './expense-period';
import { businessDay, parseDateParam } from './business-date';

/** A rule as a client sends it (create: all of it; update: any part). */
export interface RecurringRuleInput {
  locationId?: string | null;
  type?: string;
  name?: string;
  vendor?: string | null;
  kind?: string;
  amount?: number | null;
  freq?: string;
  dayOfMonth?: number | null;
  weekday?: number | null;
  startDate?: string;
  periodRule?: string;
  remindDaysBefore?: number | null;
  remindTime?: string | null;
  autoPaid?: boolean;
  paused?: boolean;
}

export interface PayrollConfigInput {
  teamMemberId: string;
  included?: boolean;
  mode?: PayrollMode;
  fixedAmount?: number | null;
  homeLocationId?: string | null;
}

/** POST /expenses/upcoming/:id/pay. periodStart/End replace a bill's default period (not payroll's). */
export interface PayOccurrenceInput {
  amount?: number;
  date: string;
  reference?: string;
  clientRequestId?: string;
  people?: { teamMemberId: string; amount?: number }[];
  includeOtherStores?: boolean;
  periodStart?: string;
  periodEnd?: string;
}

/** Each person's Square shifts in [startDay, endDay], at every store (labor payroll summary). */
export interface StaffHours {
  teamMemberId: string;
  name: string;
  shifts: { date: string; locationId: string | null; workedMinutes: number; cost: number }[];
}

// ponytail: unpaid payroll older than 8 weeks drops off the list (periods paid in cash
// before adoption, and so Square is never asked for more than ~9 weeks); widen it if
// late payroll ever needs to stay visible longer.
const PAYROLL_LOOKBACK_DAYS = 56;
// ponytail: fixed 7-day catch-up for a worker outage; older unpaid bills stay overdue for a person (they may be paid outside the app). Make it a setting if outages run longer.
const AUTO_PAY_CATCH_UP_DAYS = 7;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const BY_WEEKDAY: string[] = [RecurringFrequency.WEEKLY, RecurringFrequency.BIWEEKLY];
const oneOf = (values: object, value: unknown) => Object.values(values).includes(value);
const dayOf = (date: Date) => date.toISOString().slice(0, 10); // @db.Date comes back as UTC midnight
const isInt = (n: unknown, min: number, max: number) => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;

function refuse(message: string): never {
  throw new BadRequestException(message);
}

/** The whole rule, checked and normalized for the database, or a 400 in Spanish. */
function ruleData(rule: RecurringRuleInput) {
  if (!rule.name?.trim()) refuse('El gasto recurrente necesita un nombre');
  if (!oneOf(ExpenseType, rule.type)) refuse('Tipo de gasto no válido');
  if (!oneOf(RecurringExpenseKind, rule.kind)) refuse('Tipo de monto no válido: FIXED, VARIES o PAYROLL');
  if (!oneOf(RecurringFrequency, rule.freq)) refuse('Frecuencia no válida');
  const kind = rule.kind as RecurringExpenseKind;
  const freq = rule.freq as RecurringFrequency;
  if (kind === 'FIXED' && !positive(rule.amount)) refuse('Un gasto fijo necesita un monto mayor que cero');
  const byWeekday = BY_WEEKDAY.includes(freq);
  if (!byWeekday && !isInt(rule.dayOfMonth, 1, 31)) refuse('Indica el día del mes (1 a 31)');
  if (byWeekday && !isInt(rule.weekday, 0, 6)) refuse('Indica el día de la semana (0 domingo a 6 sábado)');
  if (!rule.startDate || !DATE_ONLY.test(rule.startDate) || isNaN(Date.parse(`${rule.startDate}T00:00:00Z`))) {
    refuse('La fecha de inicio debe ser AAAA-MM-DD');
  }
  const periodRule = rule.periodRule ?? 'DUE_MONTH';
  if (!oneOf(RecurringPeriodRule, periodRule)) refuse('Regla de periodo no válida');
  if (rule.remindDaysBefore != null && ![0, 1, 3, 7].includes(rule.remindDaysBefore)) refuse('El aviso debe ser 0, 1, 3 o 7 días antes');
  if (rule.remindTime != null && !HH_MM.test(rule.remindTime)) refuse('La hora del aviso debe ser HH:mm');
  if (rule.autoPaid && kind !== 'FIXED') refuse('El pago automático solo aplica a montos fijos');
  if (kind === 'PAYROLL' && !rule.locationId) refuse('La nómina recurrente es por sucursal');

  return {
    locationId: rule.locationId ?? null,
    type: kind === 'PAYROLL' ? ExpenseType.PAYROLL : (rule.type as ExpenseType),
    name: rule.name.trim(),
    vendor: rule.vendor ?? null,
    kind,
    amount: kind === 'FIXED' ? new Prisma.Decimal(rule.amount!) : null, // VARIES is estimated, PAYROLL computed
    freq,
    dayOfMonth: byWeekday ? null : rule.dayOfMonth!,
    weekday: byWeekday ? rule.weekday! : null,
    startDate: new Date(`${rule.startDate}T00:00:00Z`),
    periodRule: periodRule as RecurringPeriodRule,
    remindDaysBefore: rule.remindDaysBefore ?? null,
    remindTime: rule.remindTime ?? null,
    autoPaid: rule.autoPaid ?? false,
    paused: rule.paused ?? false,
  };
}

/** A stored rule in the shape a client sends, so an edit can be checked as a whole. */
const asInput = (rule: RecurringExpense): RecurringRuleInput => ({
  ...rule,
  amount: rule.amount === null ? null : Number(rule.amount),
  startDate: rule.startDate.toISOString().slice(0, 10),
});

@Injectable()
export class RecurringExpenseService {
  private readonly logger = new Logger(RecurringExpenseService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createRule(input: RecurringRuleInput, createdBy?: string) {
    return this.prisma.recurringExpense.create({ data: { ...ruleData(input), createdBy } });
  }

  async getRule(id: string) {
    const rule = await this.prisma.recurringExpense.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException(`No se encontró el gasto recurrente ${id}`);
    return rule;
  }

  /** The edit is checked against the whole rule: a field alone may be valid and the result not. */
  async updateRule(id: string, changes: RecurringRuleInput) {
    const current = await this.getRule(id);
    const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    return this.prisma.recurringExpense.update({ where: { id }, data: ruleData({ ...asInput(current), ...defined }) });
  }

  /** Its payments stay, unlinked (onDelete: SetNull). */
  async deleteRule(id: string) {
    await this.getRule(id);
    await this.prisma.recurringExpense.delete({ where: { id } });
  }

  /** undefined: every store and general; null: general only; an id: that store. */
  listRules({ locationId }: { locationId?: string | null }) {
    return this.prisma.recurringExpense.findMany({
      where: locationId === undefined ? {} : { locationId },
      orderBy: [{ name: 'asc' }],
    });
  }

  getPayrollConfig() {
    return this.prisma.payrollConfig.findMany({ orderBy: { teamMemberId: 'asc' } });
  }

  /** Upserts each person's row; fields left out keep their stored value. All rows are checked before any is saved. */
  async setPayrollConfig(rows: PayrollConfigInput[]) {
    const existing = new Map((await this.prisma.payrollConfig.findMany({
      where: { teamMemberId: { in: rows.map((r) => r.teamMemberId) } },
    })).map((c) => [c.teamMemberId, c]));
    const data = rows.map((row) => {
      if (!row.teamMemberId) refuse('Falta teamMemberId');
      const current = existing.get(row.teamMemberId);
      const merged = {
        included: row.included ?? current?.included ?? true,
        mode: row.mode ?? current?.mode ?? PayrollMode.HOURS,
        fixedAmount: row.fixedAmount !== undefined ? row.fixedAmount : current?.fixedAmount == null ? null : Number(current.fixedAmount),
        homeLocationId: row.homeLocationId !== undefined ? row.homeLocationId : current?.homeLocationId ?? null,
      };
      if (!oneOf(PayrollMode, merged.mode)) refuse('Modo de pago no válido: HOURS o FIXED');
      if (merged.mode === 'FIXED' && !positive(merged.fixedAmount)) refuse('Un sueldo fijo necesita un monto mayor que cero');
      if (merged.mode === 'FIXED' && !merged.homeLocationId) refuse('Un sueldo fijo necesita su sucursal');
      return {
        teamMemberId: row.teamMemberId,
        ...merged,
        fixedAmount: merged.fixedAmount == null ? null : new Prisma.Decimal(merged.fixedAmount),
      };
    });
    await this.prisma.$transaction(data.map(({ teamMemberId, ...fields }) => this.prisma.payrollConfig.upsert({
      where: { teamMemberId }, create: { teamMemberId, ...fields }, update: fields,
    })));
    return this.getPayrollConfig();
  }

  /**
   * Unpaid occurrences due up to `today + days`, overdue ones since each rule's
   * startDate included. A bill is paid once an expense links to its due date; a
   * payroll occurrence lists this store's people still unpaid for the period
   * (a PAYROLL expense for that person and store overlapping the period) and drops out once
   * none are left, or once it's older than the lookback. VARIES: the average of
   * the rule's last 3 payments. Payroll weeks that haven't started are left out.
   * If Square fails, everything else is still listed: payroll comes with payroll
   * and amount null, hasPayments (some payroll here overlaps the week, read from
   * the DB) and payrollUnavailable set.
   */
  async upcoming({ locationId, today, days, staff }: {
    locationId?: string | null; // undefined: every store and general; null: general only
    today: string;
    days: number;
    staff: (startDay: string, endDay: string) => Promise<StaffHours[]>;
  }) {
    const rules = await this.prisma.recurringExpense.findMany({
      where: { paused: false, ...(locationId !== undefined && { locationId }) },
      include: { expenses: { where: { occurrenceDate: { not: null } }, orderBy: [{ occurrenceDate: 'desc' }, { date: 'desc' }] } },
    });
    const until = addDays(today, days);
    const payrollFrom = addDays(today, -PAYROLL_LOOKBACK_DAYS);
    const occurrences = rules.flatMap((rule) => {
      const paid = new Set(rule.expenses.map((e) => dayOf(e.occurrenceDate!)));
      return dueDates(rule, until)
        .filter((due) => (rule.kind === 'PAYROLL' ? due >= payrollFrom : !paid.has(due)))
        .map((due) => ({ rule, due, period: occurrencePeriod(rule, due) }))
        .filter(({ period }) => rule.kind !== 'PAYROLL' || period.start <= today);
    });
    const payrollPeriods = occurrences.filter((o) => o.rule.kind === 'PAYROLL').map((o) => o.period);
    // Only Square failing is tolerated: a database error still fails the request.
    const squareStaff = (from: string, to: string) => staff(from, to).catch((error) => {
      this.logger.error('[UPCOMING] Square labor failed; payroll listed without people', error);
      return null;
    });
    const payrollFor = (await this.payrollPeople(payrollPeriods, squareStaff))?.owed;
    const hasPayments = new Map<string, boolean>(payrollFor ? [] : await Promise.all(occurrences.filter((o) => o.rule.kind === 'PAYROLL')
      .map(async ({ rule, due, period }) => [`${rule.id}:${due}`, await this.anyPayrollPaid(rule.locationId!, period)] as const)));

    const data = occurrences.flatMap(({ rule, due, period }) => {
      const base = {
        id: `${rule.id}:${due}`, ruleId: rule.id, dueDate: due, overdue: due < today, autoPaid: rule.autoPaid,
        name: rule.name, type: rule.type, vendor: rule.vendor, locationId: rule.locationId, kind: rule.kind,
        periodStart: period.start, periodEnd: period.end,
        remind: rule.remindDaysBefore == null ? null : { daysBefore: rule.remindDaysBefore, time: rule.remindTime },
      };
      if (rule.kind === 'PAYROLL') {
        if (!payrollFor) return [{ ...base, amount: null, amountIsEstimate: true, payroll: null, hasPayments: hasPayments.get(base.id)! }];
        const payroll = payrollFor(rule.locationId!, period);
        if (!payroll.length && due < today) return [];
        const total = payroll.reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));
        return [{ ...base, amount: total.toString(), amountIsEstimate: period.end >= today, payroll }];
      }
      if (rule.kind === 'FIXED') return [{ ...base, amount: rule.amount!.toString(), amountIsEstimate: false }];
      const last = rule.expenses.slice(0, 3);
      const estimate = last.length
        ? last.reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0)).div(last.length).toDecimalPlaces(2).toString()
        : null;
      return [{ ...base, amount: estimate, amountIsEstimate: true }];
    }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
    return { data, payrollUnavailable: !payrollFor };
  }

  /**
   * Who is owed for a store and period: HOURS people with shifts there (their
   * shifts' cost), FIXED people whose home it is (their salary); minus those
   * left out and those already paid. Square is asked once, for the span of all periods.
   */
  private async payrollPeople(periods: { start: string; end: string }[], staff: (s: string, e: string) => Promise<StaffHours[] | null>) {
    if (!periods.length) return { owed: () => [], isPaid: () => false, person: () => undefined };
    const from = periods.reduce((min, p) => (p.start < min ? p.start : min), periods[0].start);
    const to = periods.reduce((max, p) => (p.end > max ? p.end : max), periods[0].end);
    const [people, configs, paidRows] = await Promise.all([
      staff(from, to),
      this.getPayrollConfig(),
      this.prisma.expense.findMany({
        where: { type: 'PAYROLL', teamMemberId: { not: null }, periodStart: { lte: new Date(`${to}T00:00:00Z`) }, periodEnd: { gte: new Date(`${from}T00:00:00Z`) } },
        select: { teamMemberId: true, locationId: true, periodStart: true, periodEnd: true },
      }),
    ]);
    if (!people) return null;
    const config = new Map(configs.map((c) => [c.teamMemberId, c]));
    // Paid for a period: any of their payroll payments at that store overlaps it.
    const isPaid = (teamMemberId: string, locationId: string, period: { start: string; end: string }) => paidRows.some((e) =>
      e.teamMemberId === teamMemberId && e.locationId === locationId && dayOf(e.periodStart!) <= period.end && dayOf(e.periodEnd!) >= period.start);

    const person = (teamMemberId: string) => people.find((p) => p.teamMemberId === teamMemberId);
    const owed = (locationId: string, period: { start: string; end: string }) => people.flatMap((person) => {
      const c = config.get(person.teamMemberId);
      if (c?.included === false || isPaid(person.teamMemberId, locationId, period)) return [];
      const here = person.shifts.filter((s) => s.locationId === locationId && s.date >= period.start && s.date <= period.end);
      const minutes = here.reduce((sum, s) => sum + s.workedMinutes, 0);
      if (c?.mode === 'FIXED') {
        return c.homeLocationId === locationId ? [{ teamMemberId: person.teamMemberId, name: person.name, mode: 'FIXED', minutes, amount: c.fixedAmount!.toString() }] : [];
      }
      if (!minutes) return [];
      const cents = here.reduce((sum, s) => sum + Math.round(s.cost * 100), 0);
      return [{ teamMemberId: person.teamMemberId, name: person.name, mode: 'HOURS', minutes, amount: new Prisma.Decimal(cents).div(100).toString() }];
    });
    return { owed, isPaid, person };
  }

  /**
   * Pays an occurrence ("<ruleId>:<dueDate>"). A bill: one expense in the rule's
   * store and type, for the occurrence's period (or the one sent). Payroll: one
   * expense per person at this store, for the occurrence's period only, so
   * /upcoming sees them paid; with includeOtherStores, a person paid by hours
   * also gets their unpaid hours at other stores, their amount split by minutes
   * as POST /expenses/payroll does. Each store booked is access-checked.
   */
  async pay(occurrenceId: string, input: PayOccurrenceInput, { staff, assertAccess, createdBy, today = businessDay(new Date()) }: {
    staff: (startDay: string, endDay: string) => Promise<StaffHours[]>;
    assertAccess: (locationId: string | null) => void;
    createdBy?: string;
    today?: string; // the store's today; payroll is paid once its week has ended
  }) {
    const sep = occurrenceId.lastIndexOf(':');
    const due = occurrenceId.slice(sep + 1);
    const rule = sep > 0 && DATE_ONLY.test(due) ? await this.prisma.recurringExpense.findUnique({ where: { id: occurrenceId.slice(0, sep) } }) : null;
    if (!rule || !dueDates(rule, due).includes(due)) throw new NotFoundException('No se encontró la ocurrencia');
    assertAccess(rule.locationId);
    const occurrenceDate = new Date(`${due}T00:00:00Z`);
    const crid = input.clientRequestId;

    // A replay returns what the first request booked (payroll rows carry "<crid>:<person>:<store>").
    const replayed = async () => {
      if (!crid) return [];
      const existing = await this.prisma.expense.findMany({
        where: { OR: [{ clientRequestId: crid }, { clientRequestId: { startsWith: `${crid}:` } }] },
        orderBy: { createdAt: 'asc' },
      });
      if (existing.some((e) => e.recurringExpenseId !== rule.id || e.occurrenceDate?.getTime() !== occurrenceDate.getTime())) {
        throw new ConflictException('This clientRequestId was already used for a different expense');
      }
      return existing;
    };
    const existing = await replayed();
    for (const e of existing) if (e.locationId !== rule.locationId) assertAccess(e.locationId);
    if (existing.length) return existing;

    if (!input.date) refuse('Falta la fecha del pago');
    const date = parseDateParam(input.date, 'date')!;
    const common = { type: rule.type, date, reference: input.reference, createdBy, recurringExpenseId: rule.id, occurrenceDate };
    const alreadyPaid = () => new ConflictException('Este pago ya se registró');
    const racedOrPaid = async (error: unknown) => {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const rows = await replayed(); // two copies of the same replay
      if (rows.length) return rows;
      throw alreadyPaid();
    };

    if (rule.kind !== 'PAYROLL') {
      const amount = input.amount ?? (rule.amount === null ? undefined : Number(rule.amount));
      assertAmount(amount);
      const period = periodData(input.periodStart ?? null, input.periodEnd ?? null);
      const { start, end } = occurrencePeriod(rule, due);
      // The partial unique index (rule, occurrence) refuses a second payment.
      return this.prisma.expense.create({ data: {
        ...common, locationId: rule.locationId, vendor: rule.vendor, description: rule.name, clientRequestId: crid,
        amount: new Prisma.Decimal(amount),
        periodStart: period.periodStart ?? new Date(`${start}T00:00:00Z`), periodEnd: period.periodEnd ?? new Date(`${end}T00:00:00Z`),
      } }).then((e) => [e], racedOrPaid);
    }

    if (input.periodStart || input.periodEnd) refuse('La nómina se paga por el periodo de la ocurrencia');
    const here = rule.locationId!;
    const period = occurrencePeriod(rule, due);
    if (period.end >= today) refuse('La semana todavía no termina');
    const payroll = (await this.payrollPeople([period], staff))!; // Square failing fails the payment
    const owed = payroll.owed(here, period);
    const chosen = input.people?.length ? input.people : owed.map((p) => ({ teamMemberId: p.teamMemberId, amount: undefined }));
    if (!chosen.length) {
      if (await this.anyPayrollPaid(here, period)) throw alreadyPaid();
      refuse('Sin horas registradas en el periodo');
    }

    const rows = chosen.flatMap(({ teamMemberId, amount }) => {
      const person = owed.find((p) => p.teamMemberId === teamMemberId);
      if (!person) {
        if (!payroll.isPaid(teamMemberId, here, period)) refuse('Sin horas registradas en el periodo');
        throw new ConflictException(`Ya se le pagó a ${payroll.person(teamMemberId)?.name ?? teamMemberId} en esta sucursal por este periodo`);
      }
      if (amount !== undefined) assertAmount(amount);
      if (!input.includeOtherStores || person.mode === 'FIXED') {
        return [{ teamMemberId, locationId: here, amount: new Prisma.Decimal(amount ?? person.amount) }];
      }
      // This store first, then each other store they worked at in the period (checked in otherStoreRules).
      const stores = new Map<string, { minutes: number; cents: number }>([[here, { minutes: 0, cents: 0 }]]);
      for (const s of payroll.person(teamMemberId)!.shifts) {
        if (!s.locationId || s.date < period.start || s.date > period.end) continue;
        const store = stores.get(s.locationId) ?? { minutes: 0, cents: 0 };
        stores.set(s.locationId, { minutes: store.minutes + s.workedMinutes, cents: store.cents + Math.round(s.cost * 100) });
      }
      const parts = [...stores].filter(([, s]) => s.minutes > 0);
      const total = amount !== undefined ? BigInt(new Prisma.Decimal(amount).mul(100).toFixed(0)) : BigInt(parts.reduce((sum, [, s]) => sum + s.cents, 0));
      const cents = split(total, parts.map(([, s]) => BigInt(s.minutes)));
      return parts.map(([locationId], i) => ({ teamMemberId, locationId, amount: new Prisma.Decimal(cents[i].toString()).div(100) }));
    });
    for (const { locationId } of rows) if (locationId !== here) assertAccess(locationId);

    const periodDates = { periodStart: new Date(`${period.start}T00:00:00Z`), periodEnd: new Date(`${period.end}T00:00:00Z`) };
    const overlaps = { periodStart: { lte: periodDates.periodEnd }, periodEnd: { gte: periodDates.periodStart } };
    const ruleAt = await this.otherStoreRules(rows.filter((r) => r.locationId !== here), period, overlaps, (id) => payroll.person(id)?.name ?? id);
    // ponytail: one lock for every payroll payment (they're rare, a few a week); re-checked inside
    // so two phones paying the same person at once book it once.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payroll-pay'))`;
      const clash = await tx.expense.count({ where: {
        type: 'PAYROLL', ...overlaps, OR: rows.map(({ teamMemberId, locationId }) => ({ teamMemberId, locationId })),
      } });
      if (clash) throw alreadyPaid();
      const created = [];
      for (const row of rows) {
        created.push(await tx.expense.create({ data: {
          ...common, ...periodDates, ...row, type: 'PAYROLL', recurringExpenseId: ruleAt.get(row.locationId) ?? rule.id,
          clientRequestId: crid && `${crid}:${row.teamMemberId}:${row.locationId}`,
        } }));
      }
      return created;
    }).catch(racedOrPaid);
  }

  /**
   * Daily job (worker `auto-pay` queue): books the unpaid occurrences of each
   * active auto-paid (direct debit) fixed bill due in the last week up to
   * `today`, dated on their due date. Older ones are never backfilled: they
   * stay overdue in upcoming for a person to settle. Each occurrence has a stable clientRequestId, so a rerun books
   * nothing twice; one failing occurrence is logged and the rest still book.
   */
  async autoPay(today: string) {
    const rules = await this.prisma.recurringExpense.findMany({
      where: { autoPaid: true, paused: false }, // validation keeps autoPaid on FIXED rules only
      include: { expenses: { where: { occurrenceDate: { not: null } }, select: { occurrenceDate: true } } },
    });
    const from = addDays(today, -AUTO_PAY_CATCH_UP_DAYS);
    const due = rules.flatMap((rule) => {
      const paid = new Set(rule.expenses.map((e) => e.occurrenceDate!.toISOString().slice(0, 10)));
      return dueDates(rule, today).filter((d) => d >= from && !paid.has(d)).map((d) => `${rule.id}:${d}`);
    });
    const paid: string[] = [];
    const failed: { occurrenceId: string; error: string }[] = [];
    for (const id of due) {
      const day = id.slice(id.lastIndexOf(':') + 1);
      await this.pay(id, { date: day, clientRequestId: `auto:${id}` }, {
        staff: () => Promise.reject(new Error('A fixed bill needs no staff')), assertAccess: () => undefined,
      }).then(() => paid.push(id), (error: Error) => {
        this.logger.error(`[AUTO-PAY] ${id} failed`, error);
        failed.push({ occurrenceId: id, error: error.message });
      });
    }
    return { paid, failed };
  }

  /**
   * Paydays are per store. Another store's hours are booked only when it has no
   * payroll rule, or its own rule has an occurrence with exactly this period
   * (that rule is returned, to link its row); never over a payment there that
   * overlaps the period.
   */
  private async otherStoreRules(
    rows: { teamMemberId: string; locationId: string }[],
    period: { start: string; end: string },
    overlaps: Prisma.ExpenseWhereInput,
    personName: (teamMemberId: string) => string,
  ) {
    const ruleAt = new Map<string, string>();
    if (!rows.length) return ruleAt;
    const stores = [...new Set(rows.map((r) => r.locationId))];
    const [locations, rules, paid] = await Promise.all([
      this.prisma.location.findMany({ where: { id: { in: stores } }, select: { id: true, name: true } }),
      this.prisma.recurringExpense.findMany({ where: { kind: 'PAYROLL', locationId: { in: stores } } }),
      this.prisma.expense.findFirst({ where: { type: 'PAYROLL', ...overlaps, OR: rows }, select: { teamMemberId: true, locationId: true } }),
    ]);
    const name = (id: string | null) => locations.find((l) => l.id === id)?.name ?? id;
    if (paid) throw new ConflictException(`Ya se le pagó a ${personName(paid.teamMemberId!)} en ${name(paid.locationId)} por un periodo que se cruza`);
    const due = addDays(period.end, 1); // a payroll period ends the day before its due date
    for (const store of stores) {
      const own = rules.filter((r) => r.locationId === store);
      if (!own.length) continue;
      const same = own.find((r) => dueDates(r, due).includes(due) && occurrencePeriod(r, due).start === period.start);
      if (!same) refuse(`${name(store)} paga nómina con otro periodo; págalo desde ${name(store)}`);
      ruleAt.set(store, same.id);
    }
    return ruleAt;
  }

  private async anyPayrollPaid(locationId: string, period: { start: string; end: string }) {
    return !!(await this.prisma.expense.count({ where: {
      type: 'PAYROLL', locationId, periodStart: { lte: new Date(`${period.end}T00:00:00Z`) }, periodEnd: { gte: new Date(`${period.start}T00:00:00Z`) },
    } }));
  }
}
