import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, LocationGuard, Roles, assertLocationAccess, GuardedRequest, RoleGuardedRequest } from '../auth/guards/auth.guard';
import { RecurringExpenseService, RecurringRuleInput, PayrollConfigInput } from './recurring-expense.service';
import { readScope } from './expense.controller';

const withAmount = <T extends { amount: { toString(): string } | null }>(rule: T) => ({ ...rule, amount: rule.amount?.toString() ?? null });

/**
 * Recurring expense rules and payroll config. Registered before
 * ExpenseController so its GET /expenses/:id doesn't take these paths.
 * Managers read their store's rules; only the owner and the accountant change them.
 */
@Controller('expenses')
@UseGuards(AuthGuard, LocationGuard)
export class RecurringExpenseController {
  constructor(private readonly service: RecurringExpenseService) {}

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

  @Get('payroll-config')
  @Roles('OWNER', 'ACCOUNTANT')
  async getPayrollConfig() {
    const rows = await this.service.getPayrollConfig();
    return { success: true, data: rows.map((r) => ({ ...r, fixedAmount: r.fixedAmount?.toString() ?? null })) };
  }

  @Put('payroll-config')
  @Roles('OWNER', 'ACCOUNTANT')
  async setPayrollConfig(@Body() body: PayrollConfigInput[]) {
    const rows = await this.service.setPayrollConfig(Array.isArray(body) ? body : []);
    return { success: true, data: rows.map((r) => ({ ...r, fixedAmount: r.fixedAmount?.toString() ?? null })) };
  }

  /** A store rule needs access to its store; a general one is already owner/accountant by @Roles. */
  private async assertRuleAccess(req: GuardedRequest, id: string) {
    const { locationId } = await this.service.getRule(id);
    if (locationId) assertLocationAccess(req, locationId);
  }
}
