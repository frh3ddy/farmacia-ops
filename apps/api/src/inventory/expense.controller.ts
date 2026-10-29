import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { parseDateParam } from './business-date';
import { ExpenseType } from '@prisma/client';
import { AuthGuard, LocationGuard, Roles, scopedLocationId, Public, assertLocationAccess, GuardedRequest, RoleGuardedRequest } from '../auth/guards/auth.guard';

/** A 400 naming the valid types unless `type` is one of them. */
function assertExpenseType(type: unknown): void {
  const validTypes = Object.values(ExpenseType);
  if (!validTypes.includes(type as ExpenseType)) {
    throw new HttpException(
      { success: false, message: `Invalid expense type. Must be one of: ${validTypes.join(', ')}` },
      HttpStatus.BAD_REQUEST
    );
  }
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
  clientRequestId?: string; // Dedup key for offline-queue replay (iOS)
}

@Controller('expenses')
@UseGuards(AuthGuard, LocationGuard)
export class ExpenseController {
  constructor(private readonly expenseService: ExpenseService) {}

  // ==========================================================================
  // IMPORTANT: Specific routes MUST come before parameterized routes (:id)
  // Otherwise NestJS will match /expenses/summary/report as /expenses/:id
  // ==========================================================================

  // --------------------------------------------------------------------------
  // Get expense types - Public endpoint (MUST be before :id route)
  // --------------------------------------------------------------------------
  @Get('types/list')
  @Public()
  getExpenseTypes() {
    return {
      success: true,
      data: this.expenseService.getExpenseTypes(),
    };
  }

  // --------------------------------------------------------------------------
  // Get expense summary - OWNER, MANAGER, ACCOUNTANT (MUST be before :id route)
  // --------------------------------------------------------------------------
  @Get('summary/report')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getExpenseSummary(
    @Req() req: RoleGuardedRequest,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('includeMonthly') includeMonthly?: string
  ) {
    const targetLocationId = scopedLocationId(req, locationId);

    const summary = await this.expenseService.getExpenseSummary({
      locationId: targetLocationId,
      startDate: parseDateParam(startDate, 'startDate', 'start'),
      endDate: parseDateParam(endDate, 'endDate', 'end'),
      includeMonthly: includeMonthly === 'true',
    });

    return { success: true, data: summary };
  }

  // --------------------------------------------------------------------------
  // List expenses - OWNER, MANAGER, ACCOUNTANT (base route, before :id)
  // --------------------------------------------------------------------------
  @Get()
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async listExpenses(
    @Req() req: RoleGuardedRequest,
    @Query('locationId') locationId?: string,
    @Query('type') type?: ExpenseType,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('isPaid') isPaid?: string,
    @Query('limit') limit?: string
  ) {
    const targetLocationId = scopedLocationId(req, locationId);

    const expenses = await this.expenseService.listExpenses({
      locationId: targetLocationId,
      type,
      startDate: parseDateParam(startDate, 'startDate', 'start'),
      endDate: parseDateParam(endDate, 'endDate', 'end'),
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
  }

  // --------------------------------------------------------------------------
  // Create expense - OWNER, MANAGER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Post()
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async createExpense(@Body() body: CreateExpenseDto, @Req() req: RoleGuardedRequest) {
    const currentEmployee = req.employee;
    const currentLocation = req.currentLocation;

    // Use current location if not specified
    const locationId = body.locationId || currentLocation.locationId;

    if (!body.type || body.amount === undefined || !body.date) {
      throw new HttpException(
        { success: false, message: 'Missing required fields: type, amount, date' },
        HttpStatus.BAD_REQUEST
      );
    }

    assertExpenseType(body.type);

    const expense = await this.expenseService.createExpense({
      locationId,
      type: body.type,
      amount: body.amount,
      date: parseDateParam(body.date, 'date')!, // presence checked above
      description: body.description,
      vendor: body.vendor,
      reference: body.reference,
      isPaid: body.isPaid,
      paidAt: parseDateParam(body.paidAt, 'paidAt'),
      notes: body.notes,
      createdBy: currentEmployee.id,
      clientRequestId: body.clientRequestId,
    });

    return {
      success: true,
      message: `Expense created: ${body.type} $${body.amount}`,
      data: {
        ...expense,
        amount: expense.amount.toString(),
      },
    };
  }

  // ==========================================================================
  // Parameterized routes (:id) MUST come LAST
  // ==========================================================================

  // --------------------------------------------------------------------------
  // Get expense by ID - OWNER, MANAGER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Get(':id')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getExpense(@Param('id') id: string, @Req() req: GuardedRequest) {
    const expense = await this.expenseService.getExpense(id);
    // No locationId in the request for LocationGuard to check — check the record's.
    assertLocationAccess(req, expense.locationId);
    return {
      success: true,
      data: {
        ...expense,
        amount: expense.amount.toString(),
      },
    };
  }

  // --------------------------------------------------------------------------
  // Update expense - OWNER, MANAGER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Put(':id')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async updateExpense(@Param('id') id: string, @Body() body: Partial<CreateExpenseDto>, @Req() req: GuardedRequest) {
    assertLocationAccess(req, (await this.expenseService.getExpense(id)).locationId);
    if (body.type !== undefined) assertExpenseType(body.type);
    const expense = await this.expenseService.updateExpense(id, {
      type: body.type,
      amount: body.amount,
      date: parseDateParam(body.date, 'date'),
      description: body.description,
      vendor: body.vendor,
      reference: body.reference,
      isPaid: body.isPaid,
      paidAt: parseDateParam(body.paidAt, 'paidAt'),
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
  }

  // --------------------------------------------------------------------------
  // Delete expense - OWNER, ACCOUNTANT only
  // --------------------------------------------------------------------------
  @Delete(':id')
  @Roles('OWNER', 'ACCOUNTANT')
  async deleteExpense(@Param('id') id: string, @Req() req: GuardedRequest) {
    assertLocationAccess(req, (await this.expenseService.getExpense(id)).locationId);
    await this.expenseService.deleteExpense(id);
    return { success: true, message: 'Expense deleted' };
  }
}
