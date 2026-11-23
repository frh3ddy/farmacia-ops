import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { listLimit } from './list-limit';
import { split, expensePeriodOverlaps, expenseShareDecimal, expenseSharesByMonth, reportDays } from './expense-period';
import { Prisma, ExpenseType } from '@prisma/client';

// ============================================================================
// Types
// ============================================================================

interface CreateExpenseInput {
  locationId: string | null; // null: general (business-wide)
  type: ExpenseType;
  amount: number;
  date: Date;
  periodStart?: string | null; // YYYY-MM-DD store days, both or neither; two nulls clear it on update
  periodEnd?: string | null;
  description?: string;
  vendor?: string;
  reference?: string;
  isPaid?: boolean;
  paidAt?: Date;
  notes?: string;
  createdBy?: string;
  clientRequestId?: string; // Dedup key for offline-queue replay (iOS)
}

interface ExpenseSummary {
  period: { startDate?: Date; endDate?: Date };
  locationId?: string | null;
  totals: {
    totalExpenses: string;
    expenseCount: number;
    paidExpenses: string;
    unpaidExpenses: string;
  };
  byType: Array<{
    type: ExpenseType;
    total: string;
    count: number;
    percentage: string;
  }>;
  byMonth?: Array<{
    month: string;
    total: string;
    count: number;
  }>;
}

/** The controller's DTO is a plain interface, so nothing has checked what the client sent. */
function assertAmount(amount: unknown): void {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestException('El monto del gasto debe ser un número mayor que cero');
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The period as stored (@db.Date), or a 400 in Spanish. Neither end: no period. */
function periodData(start?: string | null, end?: string | null) {
  if (!start && !end) return {};
  if (!start || !end) throw new BadRequestException('El periodo necesita inicio y fin');
  if (![start, end].every((d) => DATE_ONLY.test(d) && !isNaN(Date.parse(`${d}T00:00:00Z`)))) {
    throw new BadRequestException('El periodo debe tener fechas AAAA-MM-DD');
  }
  if (end < start) throw new BadRequestException('El fin del periodo no puede ser antes del inicio');
  return { periodStart: new Date(`${start}T00:00:00Z`), periodEnd: new Date(`${end}T00:00:00Z`) };
}

/** undefined: every store and general; null: general only; an id: that store. */
const locationWhere = (locationId?: string | null): Prisma.ExpenseWhereInput =>
  locationId === undefined ? {} : { locationId };

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class ExpenseService {
  private readonly logger = new Logger(ExpenseService.name);

  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------------------
  // Create expense
  // --------------------------------------------------------------------------
  async createExpense(input: CreateExpenseInput) {
    this.logger.log(`[EXPENSE] Creating ${input.type} expense: $${input.amount}`);
    assertAmount(input.amount);
    const period = periodData(input.periodStart, input.periodEnd);

    // Idempotent replay: the offline-queue (iOS) may retry a write whose
    // original response was lost after it actually committed. Recognize the
    // client-supplied dedup key and return the existing row instead of
    // creating a duplicate expense.
    if (input.clientRequestId) {
      const existing = await this.findByClientRequestId(input);
      if (existing) {
        this.logger.log(`[EXPENSE] Duplicate clientRequestId ${input.clientRequestId} — returning existing expense ${existing.id}`);
        return existing;
      }
    }

    const expense = await this.prisma.expense.create({
      data: {
        locationId: input.locationId,
        type: input.type,
        amount: new Prisma.Decimal(input.amount),
        date: input.date,
        ...period,
        description: input.description,
        vendor: input.vendor,
        reference: input.reference,
        isPaid: input.isPaid ?? true,
        paidAt: input.paidAt,
        notes: input.notes,
        createdBy: input.createdBy,
        clientRequestId: input.clientRequestId,
      },
      include: {
        location: { select: { id: true, name: true } },
      },
    }).catch(async (error) => {
      // Two copies of the same replay raced past the lookup above; the loser's
      // insert hits the unique dedup key.
      if (input.clientRequestId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.findByClientRequestId(input);
        if (existing) return existing;
      }
      throw error;
    });

    return expense;
  }

  private async findByClientRequestId(input: CreateExpenseInput) {
    const existing = await this.prisma.expense.findUnique({
      where: { clientRequestId: input.clientRequestId },
      include: { location: { select: { id: true, name: true } } },
    });
    if (!existing) return null;
    // A replay repeats its request exactly. Anything else reusing the key is a
    // client bug — or a probe for another location's expense.
    const sameRequest = existing.locationId === input.locationId
      && existing.type === input.type
      && existing.amount.equals(input.amount);
    if (!sameRequest) {
      throw new ConflictException('This clientRequestId was already used for a different expense');
    }
    return existing;
  }

  // --------------------------------------------------------------------------
  // Payroll: one expense per store, by the minutes worked there
  // --------------------------------------------------------------------------
  async createPayrollExpenses(input: {
    teamMemberId: string;
    periodStart?: string;
    periodEnd?: string;
    amount: number;
    date: Date;
    reference?: string;
    createdBy?: string;
    clientRequestId?: string;
    /** Minutes per store in the period (the labor payroll summary); asked only once the request is valid. */
    hours: () => Promise<{ locationId: string; workedMinutes: number }[]>;
  }) {
    assertAmount(input.amount);
    const period = periodData(input.periodStart ?? null, input.periodEnd ?? null);
    if (!period.periodStart) throw new BadRequestException('El periodo necesita inicio y fin');
    const worked = (await input.hours()).filter((s) => s.workedMinutes > 0);
    if (!worked.length) throw new BadRequestException('Sin horas registradas en el periodo');

    // A replay's expenses carry "<clientRequestId>:<locationId>" (the column is unique).
    const keys = input.clientRequestId ? worked.map((s) => `${input.clientRequestId}:${s.locationId}`) : [];
    const replayed = async () => {
      const existing = await this.prisma.expense.findMany({ where: { clientRequestId: { in: keys } } });
      if (existing.some((e) => e.teamMemberId !== input.teamMemberId)) {
        throw new ConflictException('This clientRequestId was already used for a different expense');
      }
      return worked.map((s) => existing.find((e) => e.locationId === s.locationId)).filter((e) => e !== undefined);
    };
    if (keys.length) {
      const existing = await replayed();
      if (existing.length) return existing;
    }

    const cents = split(BigInt(new Prisma.Decimal(input.amount).mul(100).toFixed(0)), worked.map((s) => BigInt(s.workedMinutes)));
    return this.prisma.$transaction(worked.map((s, i) => this.prisma.expense.create({
      data: {
        locationId: s.locationId,
        type: 'PAYROLL',
        amount: new Prisma.Decimal(cents[i].toString()).div(100),
        date: input.date,
        ...period,
        teamMemberId: input.teamMemberId,
        reference: input.reference,
        createdBy: input.createdBy,
        clientRequestId: keys[i],
      },
    }))).catch(async (error) => {
      // Two copies of the same replay raced past the lookup above.
      if (keys.length && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await replayed();
        if (existing.length) return existing;
      }
      throw error;
    });
  }

  // --------------------------------------------------------------------------
  // Update expense
  // --------------------------------------------------------------------------
  async updateExpense(id: string, updates: Partial<CreateExpenseInput>) {
    if (updates.amount !== undefined) assertAmount(updates.amount);
    // Both ends are sent together; two nulls clear the period.
    const period = updates.periodStart !== undefined || updates.periodEnd !== undefined
      ? { periodStart: null, periodEnd: null, ...periodData(updates.periodStart, updates.periodEnd) }
      : {};
    const expense = await this.prisma.expense.update({
      where: { id },
      data: {
        ...(updates.type && { type: updates.type }),
        ...(updates.amount !== undefined && { amount: new Prisma.Decimal(updates.amount) }),
        ...(updates.date && { date: updates.date }),
        ...period,
        ...(updates.description !== undefined && { description: updates.description }),
        ...(updates.vendor !== undefined && { vendor: updates.vendor }),
        ...(updates.reference !== undefined && { reference: updates.reference }),
        ...(updates.isPaid !== undefined && { isPaid: updates.isPaid }),
        ...(updates.paidAt !== undefined && { paidAt: updates.paidAt }),
        ...(updates.notes !== undefined && { notes: updates.notes }),
      },
      include: {
        location: { select: { id: true, name: true } },
      },
    });

    return expense;
  }

  // --------------------------------------------------------------------------
  // Delete expense
  // --------------------------------------------------------------------------
  async deleteExpense(id: string) {
    await this.prisma.expense.delete({ where: { id } });
    return { success: true };
  }

  // --------------------------------------------------------------------------
  // Get expense
  // --------------------------------------------------------------------------
  async getExpense(id: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id },
      include: {
        location: { select: { id: true, name: true } },
      },
    });

    if (!expense) {
      throw new NotFoundException(`Expense ${id} not found`);
    }

    return expense;
  }

  // --------------------------------------------------------------------------
  // List expenses
  // --------------------------------------------------------------------------
  async listExpenses(options: {
    locationId?: string | null;
    type?: ExpenseType;
    startDate?: Date;
    endDate?: Date;
    isPaid?: boolean;
    limit?: number;
  }) {
    const { locationId, type, startDate, endDate, isPaid, limit } = options;

    return this.prisma.expense.findMany({
      where: {
        ...locationWhere(locationId),
        ...(type && { type }),
        ...expensePeriodOverlaps(startDate, endDate),
        ...(isPaid !== undefined && { isPaid }),
      },
      include: {
        location: { select: { id: true, name: true } },
      },
      orderBy: { date: 'desc' },
      take: listLimit(limit),
    });
  }

  // --------------------------------------------------------------------------
  // Get expense summary
  // --------------------------------------------------------------------------
  async getExpenseSummary(options: {
    locationId?: string | null;
    startDate?: Date;
    endDate?: Date;
    includeMonthly?: boolean;
  }): Promise<ExpenseSummary> {
    const { locationId, startDate, endDate, includeMonthly } = options;

    const expenses = await this.prisma.expense.findMany({
      where: { ...locationWhere(locationId), ...expensePeriodOverlaps(startDate, endDate) },
    });
    const [startDay, endDay] = reportDays(startDate, endDate);

    // Calculate totals
    let totalExpenses = new Prisma.Decimal(0);
    let paidExpenses = new Prisma.Decimal(0);
    let unpaidExpenses = new Prisma.Decimal(0);

    const byTypeMap = new Map<ExpenseType, { total: Prisma.Decimal; count: number }>();
    const byMonthMap = new Map<string, { total: Prisma.Decimal; count: number }>();

    for (const expense of expenses) {
      // Only the part of its period inside the range counts.
      const share = expenseShareDecimal(expense, startDay, endDay);
      totalExpenses = totalExpenses.add(share);

      if (expense.isPaid) {
        paidExpenses = paidExpenses.add(share);
      } else {
        unpaidExpenses = unpaidExpenses.add(share);
      }

      // By type
      const typeEntry = byTypeMap.get(expense.type);
      if (typeEntry) {
        typeEntry.total = typeEntry.total.add(share);
        typeEntry.count++;
      } else {
        byTypeMap.set(expense.type, { total: share, count: 1 });
      }

      // By month: a period across months counts in each, by its share.
      if (includeMonthly) {
        for (const [monthKey, monthShare] of expenseSharesByMonth(expense, startDay, endDay)) {
          const monthEntry = byMonthMap.get(monthKey);
          if (monthEntry) {
            monthEntry.total = monthEntry.total.add(monthShare);
            monthEntry.count++;
          } else {
            byMonthMap.set(monthKey, { total: new Prisma.Decimal(monthShare), count: 1 });
          }
        }
      }
    }

    // Build by-type array with percentages
    const byType = Array.from(byTypeMap.entries())
      .map(([type, data]) => ({
        type,
        total: data.total.toString(),
        count: data.count,
        percentage: totalExpenses.gt(0)
          ? data.total.div(totalExpenses).mul(100).toFixed(2)
          : '0.00',
      }))
      .sort((a, b) => parseFloat(b.total) - parseFloat(a.total));

    // Build by-month array
    const byMonth = includeMonthly
      ? Array.from(byMonthMap.entries())
          .map(([month, data]) => ({
            month,
            total: data.total.toString(),
            count: data.count,
          }))
          .sort((a, b) => a.month.localeCompare(b.month))
      : undefined;

    return {
      period: { startDate, endDate },
      locationId,
      totals: {
        totalExpenses: totalExpenses.toString(),
        expenseCount: expenses.length,
        paidExpenses: paidExpenses.toString(),
        unpaidExpenses: unpaidExpenses.toString(),
      },
      byType,
      byMonth,
    };
  }

  // --------------------------------------------------------------------------
  // Get expense types
  // --------------------------------------------------------------------------
  getExpenseTypes() {
    return Object.values(ExpenseType).map(type => ({
      value: type,
      label: type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()),
    }));
  }
}
