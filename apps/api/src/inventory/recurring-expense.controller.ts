import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, LocationGuard, Roles, assertLocationAccess, GuardedRequest, RoleGuardedRequest } from '../auth/guards/auth.guard';
import { RecurringExpenseService, RecurringRuleInput, PayrollConfigInput, PayOccurrenceInput } from './recurring-expense.service';
import { LaborService } from '../labor/labor.service';
import { businessDay } from './business-date';
import { assertGeneralAccess, readScope } from './expense.controller';

const withAmount = <T extends { amount: { toString(): string } | null }>(rule: T) => ({ ...rule, amount: rule.amount?.toString() ?? null });

/**
 * Recurring expense rules and payroll config. Registered before
 * ExpenseController so its GET /expenses/:id doesn't take these paths.
 * Managers read their store's rules; only the owner and the accountant change them.
 */
@Controller('expenses')
@UseGuards(AuthGuard, LocationGuard)
export class RecurringExpenseController {
  constructor(private readonly service: RecurringExpenseService, private readonly labor: LaborService) {}

  /** Due and overdue occurrences (store scope as GET /expenses); a manager gets their own store. */
  @Get('upcoming')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async upcoming(@Req() req: RoleGuardedRequest, @Query('locationId') locationId?: string, @Query('scope') scope?: string, @Query('days') days?: string) {
    const horizon = days === undefined ? 30 : Number(days);
    if (!Number.isInteger(horizon) || horizon < 0 || horizon > 366) throw new BadRequestException('days debe ser un número entero de 0 a 366');
    const { data, payrollUnavailable } = await this.service.upcoming({
      locationId: readScope(req, locationId, scope),
      today: businessDay(new Date()),
      days: horizon,
      staff: (from, to) => this.labor.getShiftsByPerson(from, to),
    });
    return { success: true, data, payrollUnavailable };
  }

  /** Books an occurrence ("<ruleId>:<dueDate>"); each store it books in needs access, general needs owner or accountant. */
  @Post('upcoming/:id/pay')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async pay(@Param('id') id: string, @Body() body: PayOccurrenceInput, @Req() req: RoleGuardedRequest) {
    const expenses = await this.service.pay(id, body ?? ({} as PayOccurrenceInput), {
      staff: (from, to) => this.labor.getShiftsByPerson(from, to),
      assertAccess: (locationId) => (locationId ? assertLocationAccess(req, locationId) : assertGeneralAccess(req)),
      createdBy: req.employee.id,
    });
    return { success: true, data: { expenses: expenses.map((e) => ({ ...e, amount: e.amount.toString() })) } };
  }

  @Get('recurring')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async listRules(@Req() req: RoleGuardedRequest, @Query('locationId') locationId?: string, @Query('scope') scope?: string) {
    const rules = await this.service.listRules({ locationId: readScope(req, locationId, scope) });
    return { success: true, data: rules.map(withAmount) };
  }

  @Post('recurring')
  @Roles('OWNER', 'ACCOUNTANT')
  async createRule(@Body() body: RecurringRuleInput, @Req() req: RoleGuardedRequest) {
    if (body.locationId) assertLocationAccess(req, body.locationId);
    return { success: true, data: withAmount(await this.service.createRule(body, req.employee.id)) };
  }

  @Put('recurring/:id')
  @Roles('OWNER', 'ACCOUNTANT')
  async updateRule(@Param('id') id: string, @Body() body: RecurringRuleInput, @Req() req: GuardedRequest) {
    await this.assertRuleAccess(req, id);
    if (body.locationId) assertLocationAccess(req, body.locationId); // moving it to another store
    return { success: true, data: withAmount(await this.service.updateRule(id, body)) };
  }

  @Delete('recurring/:id')
  @Roles('OWNER', 'ACCOUNTANT')
  async deleteRule(@Param('id') id: string, @Req() req: GuardedRequest) {
    await this.assertRuleAccess(req, id);
    await this.service.deleteRule(id);
    return { success: true };
  }

  // An accountant sees and sets only the salaries of the stores they can access
  // (a home there, or none); the owner, all of them.
  @Get('payroll-config')
  @Roles('OWNER', 'ACCOUNTANT')
  async getPayrollConfig(@Req() req: GuardedRequest) {
    return { success: true, data: this.visibleConfig(req, await this.service.getPayrollConfig()) };
  }

  @Put('payroll-config')
  @Roles('OWNER', 'ACCOUNTANT')
  async setPayrollConfig(@Body() body: PayrollConfigInput[], @Req() req: GuardedRequest) {
    const rows = Array.isArray(body) ? body : [];
    const storedHome = new Map((await this.service.getPayrollConfig()).map((c) => [c.teamMemberId, c.homeLocationId]));
    for (const row of rows) {
      for (const home of [row.homeLocationId, storedHome.get(row.teamMemberId)]) {
        if (home) assertLocationAccess(req, home);
      }
    }
    return { success: true, data: this.visibleConfig(req, await this.service.setPayrollConfig(rows)) };
  }

  private visibleConfig<T extends { homeLocationId: string | null; fixedAmount: { toString(): string } | null }>(req: GuardedRequest, rows: T[]) {
    const canSee = (home: string | null) => {
      if (!home) return true;
      try {
        assertLocationAccess(req, home);
        return true;
      } catch {
        return false;
      }
    };
    return rows.filter((r) => canSee(r.homeLocationId)).map((r) => ({ ...r, fixedAmount: r.fixedAmount?.toString() ?? null }));
  }

  /** A store rule needs access to its store; a general one is already owner/accountant by @Roles. */
  private async assertRuleAccess(req: GuardedRequest, id: string) {
    const { locationId } = await this.service.getRule(id);
    if (locationId) assertLocationAccess(req, locationId);
  }
}
