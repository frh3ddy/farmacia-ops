import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ExpenseType, PayrollMode, Prisma, RecurringExpense, RecurringExpenseKind, RecurringFrequency, RecurringPeriodRule,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const BY_WEEKDAY: string[] = [RecurringFrequency.WEEKLY, RecurringFrequency.BIWEEKLY];
const oneOf = (values: object, value: unknown) => Object.values(values).includes(value);
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
}
