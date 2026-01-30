import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, ExpenseType } from '@prisma/client';

// ============================================================================
// Types
// ============================================================================

interface CreateExpenseInput {
  locationId: string;
  type: ExpenseType;
  amount: number;
  date: Date;
  description?: string;
  vendor?: string;
  reference?: string;
  isPaid?: boolean;
  paidAt?: Date;
  notes?: string;
  createdBy?: string;
}

interface ExpenseSummary {
  period: { startDate?: Date; endDate?: Date };
  locationId?: string;
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

    const expense = await this.prisma.expense.create({
      data: {
        locationId: input.locationId,
        type: input.type,
        amount: new Prisma.Decimal(input.amount),
        date: input.date,
        description: input.description,
        vendor: input.vendor,
        reference: input.reference,
        isPaid: input.isPaid ?? true,
        paidAt: input.paidAt,
        notes: input.notes,
        createdBy: input.createdBy,
      },
      include: {
        location: { select: { id: true, name: true } },
      },
    });

    return expense;
  }

  // --------------------------------------------------------------------------
  // Update expense
  // --------------------------------------------------------------------------
  async updateExpense(id: string, updates: Partial<CreateExpenseInput>) {
    const expense = await this.prisma.expense.update({
      where: { id },
      data: {
        ...(updates.type && { type: updates.type }),
        ...(updates.amount !== undefined && { amount: new Prisma.Decimal(updates.amount) }),
        ...(updates.date && { date: updates.date }),
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
    locationId?: string;
    type?: ExpenseType;
    startDate?: Date;
    endDate?: Date;
    isPaid?: boolean;
    limit?: number;
  }) {
    const { locationId, type, startDate, endDate, isPaid, limit } = options;

    return this.prisma.expense.findMany({
      where: {
        ...(locationId && { locationId }),
        ...(type && { type }),
        ...(startDate && { date: { gte: startDate } }),
        ...(endDate && { date: { lte: endDate } }),
        ...(isPaid !== undefined && { isPaid }),
      },
      include: {
        location: { select: { id: true, name: true } },
      },
      orderBy: { date: 'desc' },
      take: limit || 100,
    });
  }

  // --------------------------------------------------------------------------
  // Get expense summary
  // --------------------------------------------------------------------------
  async getExpenseSummary(options: {
    locationId?: string;
    startDate?: Date;
    endDate?: Date;
    includeMonthly?: boolean;
  }): Promise<ExpenseSummary> {
    const { locationId, startDate, endDate, includeMonthly } = options;

    const where: Prisma.ExpenseWhereInput = {
      ...(locationId && { locationId }),
      ...(startDate && { date: { gte: startDate } }),
      ...(endDate && { date: { lte: endDate } }),
    };

    // Get all expenses for the period
    const expenses = await this.prisma.expense.findMany({ where });

    // Calculate totals
    let totalExpenses = new Prisma.Decimal(0);
    let paidExpenses = new Prisma.Decimal(0);
    let unpaidExpenses = new Prisma.Decimal(0);

    const byTypeMap = new Map<ExpenseType, { total: Prisma.Decimal; count: number }>();
    const byMonthMap = new Map<string, { total: Prisma.Decimal; count: number }>();

    for (const expense of expenses) {
      totalExpenses = totalExpenses.add(expense.amount);

      if (expense.isPaid) {
        paidExpenses = paidExpenses.add(expense.amount);
      } else {
        unpaidExpenses = unpaidExpenses.add(expense.amount);
      }

      // By type
      const typeEntry = byTypeMap.get(expense.type);
      if (typeEntry) {
        typeEntry.total = typeEntry.total.add(expense.amount);
        typeEntry.count++;
      } else {
        byTypeMap.set(expense.type, { total: expense.amount, count: 1 });
      }

      // By month
      if (includeMonthly) {
        const monthKey = expense.date.toISOString().slice(0, 7); // YYYY-MM
        const monthEntry = byMonthMap.get(monthKey);
        if (monthEntry) {
          monthEntry.total = monthEntry.total.add(expense.amount);
          monthEntry.count++;
        } else {
          byMonthMap.set(monthKey, { total: expense.amount, count: 1 });
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
