import { Controller, Post, UseGuards } from '@nestjs/common';
import { WorkerSecretGuard } from '../auth/guards/worker-secret.guard';
import { businessDay } from './business-date';
import { RecurringExpenseService } from './recurring-expense.service';

/** Routes only the worker calls (worker secret, no staff session). */
@Controller('internal/expenses')
@UseGuards(WorkerSecretGuard)
export class InternalExpensesController {
  constructor(private readonly recurring: RecurringExpenseService) {}

  /** Daily at 06:00 store time (worker `auto-pay` queue): books the direct-debit bills due up to today. */
  @Post('auto-pay')
  async autoPay() {
    return { success: true, data: await this.recurring.autoPay(businessDay(new Date())) };
  }
}
