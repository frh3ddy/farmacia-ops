import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { ExpenseType } from '@prisma/client';

// Helper functions
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getErrorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

// DTOs
interface CreateExpenseDto {
  locationId: string;
  type: ExpenseType;
  amount: number;
  date: string;
  description?: string;
  vendor?: string;
  reference?: string;
  isPaid?: boolean;
  paidAt?: string;
  notes?: string;
  createdBy?: string;
}

@Controller('expenses')
export class ExpenseController {
  constructor(private readonly expenseService: ExpenseService) {}

  // --------------------------------------------------------------------------
  // Create expense
  // --------------------------------------------------------------------------
  @Post()
  async createExpense(@Body() body: CreateExpenseDto) {
    try {
      if (!body.locationId || !body.type || body.amount === undefined || !body.date) {
        throw new HttpException(
          { success: false, message: 'Missing required fields: locationId, type, amount, date' },
          HttpStatus.BAD_REQUEST
        );
      }

      const validTypes = Object.values(ExpenseType);
      if (!validTypes.includes(body.type)) {
        throw new HttpException(
          { success: false, message: `Invalid expense type. Must be one of: ${validTypes.join(', ')}` },
          HttpStatus.BAD_REQUEST
        );
      }

      const expense = await this.expenseService.createExpense({
        locationId: body.locationId,
        type: body.type,
        amount: body.amount,
        date: new Date(body.date),
        description: body.description,
        vendor: body.vendor,
        reference: body.reference,
        isPaid: body.isPaid,
        paidAt: body.paidAt ? new Date(body.paidAt) : undefined,
        notes: body.notes,
        createdBy: body.createdBy,
      });

      return {
        success: true,
        message: `Expense created: ${body.type} $${body.amount}`,
        data: {
          ...expense,
          amount: expense.amount.toString(),
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Update expense
  // --------------------------------------------------------------------------
  @Put(':id')
  async updateExpense(@Param('id') id: string, @Body() body: Partial<CreateExpenseDto>) {
    try {
      const expense = await this.expenseService.updateExpense(id, {
        type: body.type,
        amount: body.amount,
        date: body.date ? new Date(body.date) : undefined,
        description: body.description,
        vendor: body.vendor,
        reference: body.reference,
        isPaid: body.isPaid,
        paidAt: body.paidAt ? new Date(body.paidAt) : undefined,
        notes: body.notes,
      });

      return {
        success: true,
        message: 'Expense updated',
        data: {
          ...expense,
          amount: expense.amount.toString(),
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Delete expense
  // --------------------------------------------------------------------------
  @Delete(':id')
  async deleteExpense(@Param('id') id: string) {
    try {
      await this.expenseService.deleteExpense(id);
      return { success: true, message: 'Expense deleted' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Get expense
  // --------------------------------------------------------------------------
  @Get(':id')
  async getExpense(@Param('id') id: string) {
    try {
      const expense = await this.expenseService.getExpense(id);
      return {
        success: true,
        data: {
          ...expense,
          amount: expense.amount.toString(),
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // List expenses
  // --------------------------------------------------------------------------
  @Get()
  async listExpenses(
    @Query('locationId') locationId?: string,
    @Query('type') type?: ExpenseType,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('isPaid') isPaid?: string,
    @Query('limit') limit?: string
  ) {
    try {
      const expenses = await this.expenseService.listExpenses({
        locationId,
        type,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        isPaid: isPaid !== undefined ? isPaid === 'true' : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });

      return {
        success: true,
        count: expenses.length,
        data: expenses.map(e => ({
          ...e,
          amount: e.amount.toString(),
        })),
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Get expense summary
  // --------------------------------------------------------------------------
  @Get('summary/report')
  async getExpenseSummary(
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('includeMonthly') includeMonthly?: string
  ) {
    try {
      const summary = await this.expenseService.getExpenseSummary({
        locationId,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        includeMonthly: includeMonthly === 'true',
      });

      return { success: true, data: summary };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Get expense types
  // --------------------------------------------------------------------------
  @Get('types/list')
  getExpenseTypes() {
    return {
      success: true,
      data: this.expenseService.getExpenseTypes(),
    };
  }
}
