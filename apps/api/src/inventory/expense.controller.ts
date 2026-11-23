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
import { LaborService } from '../labor/labor.service';
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

/**
 * General (no-store) expenses are for the owner and the accountant only. A
 * record's null locationId, or a request for scope=general, comes through here.
 */
function assertGeneralAccess(req: GuardedRequest): void {
  if (!['OWNER', 'ACCOUNTANT'].includes(req.currentLocation?.role as string)) {
    throw new HttpException(
      { success: false, message: 'Solo el dueño o el contador pueden ver gastos generales' },
      HttpStatus.FORBIDDEN
    );
  }
}

/** A record's store, or the general-expense check when it has none. */
function assertExpenseAccess(req: GuardedRequest, locationId: string | null): void {
  if (locationId === null) assertGeneralAccess(req);
  else assertLocationAccess(req, locationId);
}

/** scope=general: only general expenses (null); otherwise the usual store scope. */
function readScope(req: GuardedRequest, locationId?: string, scope?: string): string | null | undefined {
  if (scope === 'general') {
    assertGeneralAccess(req);
    return null;
  }
  return scopedLocationId(req, locationId);
}

// DTOs
interface CreateExpenseDto {
  locationId?: string | null; // null: general (no store); left out: the session store
  type: ExpenseType;
  amount: number;
  date: string;
  periodStart?: string | null; // YYYY-MM-DD store days it covers, both or neither
  periodEnd?: string | null;
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
  constructor(
    private readonly expenseService: ExpenseService,
    private readonly laborService: LaborService,
  ) {}

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
    @Query('scope') scope?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('includeMonthly') includeMonthly?: string
  ) {
    const targetLocationId = readScope(req, locationId, scope);

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
    @Query('scope') scope?: string,
    @Query('type') type?: ExpenseType,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('isPaid') isPaid?: string,
    @Query('limit') limit?: string
  ) {
    const targetLocationId = readScope(req, locationId, scope);

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

    // An explicit null is a general expense; leaving it out means the session store.
    const locationId = body.locationId === null ? null : body.locationId || currentLocation.locationId;
    if (locationId === null) assertGeneralAccess(req);

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
      periodStart: body.periodStart ?? undefined,
      periodEnd: body.periodEnd ?? undefined,
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

  // --------------------------------------------------------------------------
  // Pay a person: one PAYROLL expense per store, by their Square hours there
  // --------------------------------------------------------------------------
  @Post('payroll')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async createPayrollExpense(
    @Body() body: { teamMemberId: string; periodStart: string; periodEnd: string; amount: number; date: string; reference?: string; clientRequestId?: string },
    @Req() req: RoleGuardedRequest,
  ) {
    if (!body.teamMemberId || body.amount === undefined || !body.date) {
      throw new HttpException(
        { success: false, message: 'Missing required fields: teamMemberId, amount, date' },
        HttpStatus.BAD_REQUEST
      );
    }
    const expenses = await this.expenseService.createPayrollExpenses({
      teamMemberId: body.teamMemberId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      amount: body.amount,
      date: parseDateParam(body.date, 'date')!,
      reference: body.reference,
      createdBy: req.employee.id,
      clientRequestId: body.clientRequestId,
      hours: async () => {
        const { stores } = await this.laborService.getPayrollSummary(body.teamMemberId, { startDate: body.periodStart, endDate: body.periodEnd });
        // Hours at a Square location that isn't one of ours aren't charged here.
        const ours = stores.flatMap((s) => (s.locationId && s.workedMinutes > 0 ? [{ locationId: s.locationId, workedMinutes: s.workedMinutes }] : []));
        // Each store's part is an expense there: the payer needs access to all of them.
        for (const s of ours) assertLocationAccess(req, s.locationId);
        return ours;
      },
    });
    return {
      success: true,
      data: { expenses: expenses.map((e) => ({ ...e, amount: e.amount.toString() })) },
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
    assertExpenseAccess(req, expense.locationId);
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
    assertExpenseAccess(req, (await this.expenseService.getExpense(id)).locationId);
    if (body.type !== undefined) assertExpenseType(body.type);
    const expense = await this.expenseService.updateExpense(id, {
      type: body.type,
      amount: body.amount,
      date: parseDateParam(body.date, 'date'),
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
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
    assertExpenseAccess(req, (await this.expenseService.getExpense(id)).locationId);
    await this.expenseService.deleteExpense(id);
    return { success: true, message: 'Expense deleted' };
  }
}
