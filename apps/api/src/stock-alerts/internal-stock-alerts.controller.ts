import { Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { WorkerSecretGuard } from '../auth/guards/worker-secret.guard';
import { PrismaService } from '../prisma/prisma.service';
import { recordStockDays } from './stock-days';
import { recordStockStats } from './stock-stats';

/** Routes only the worker calls (worker secret, no staff session). */
@Controller('internal/stock-alerts')
@UseGuards(WorkerSecretGuard)
export class InternalStockAlertsController {
  private readonly logger = new Logger(InternalStockAlertsController.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Nightly (worker `stock-days` queue): stores the stock days missing up to yesterday, then the stats read from them. */
  @Post('stock-days')
  async stockDays() {
    // Each half timed apart, so the logs show which one is slow if the worker's call times out.
    const timed = async (label: string, run: () => Promise<number>) => {
      const start = Date.now();
      const rows = await run();
      this.logger.log(`${label}: ${rows} rows in ${Date.now() - start} ms`);
      return rows;
    };
    const saved = await timed('Stock days', () => recordStockDays(this.prisma));
    return { success: true, data: { saved, stats: await timed('Stock stats', () => recordStockStats(this.prisma)) } };
  }
}
