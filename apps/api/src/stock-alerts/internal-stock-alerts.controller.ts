import { Controller, Post, UseGuards } from '@nestjs/common';
import { WorkerSecretGuard } from '../auth/guards/worker-secret.guard';
import { PrismaService } from '../prisma/prisma.service';
import { recordStockDays } from './stock-days';
import { recordStockStats } from './stock-stats';

/** Routes only the worker calls (worker secret, no staff session). */
@Controller('internal/stock-alerts')
@UseGuards(WorkerSecretGuard)
export class InternalStockAlertsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Nightly (worker `stock-days` queue): stores the stock days missing up to yesterday, then the stats read from them. */
  @Post('stock-days')
  async stockDays() {
    const saved = await recordStockDays(this.prisma);
    return { success: true, data: { saved, stats: await recordStockStats(this.prisma) } };
  }
}
