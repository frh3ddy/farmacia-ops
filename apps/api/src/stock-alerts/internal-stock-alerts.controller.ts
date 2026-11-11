import { Controller, Post, UseGuards } from '@nestjs/common';
import { WorkerSecretGuard } from '../auth/guards/worker-secret.guard';
import { PrismaService } from '../prisma/prisma.service';
import { recordStockDays } from './stock-days';

/** Routes only the worker calls (worker secret, no staff session). */
@Controller('internal/stock-alerts')
@UseGuards(WorkerSecretGuard)
export class InternalStockAlertsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Nightly (worker `stock-days` queue): stores the stock days missing up to yesterday. */
  @Post('stock-days')
  async stockDays() {
    return { success: true, data: { saved: await recordStockDays(this.prisma) } };
  }
}
