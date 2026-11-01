import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SaleQueue, workerError } from '../queues/sale.queue';
import { AuthGuard, LocationGuard, Roles } from '../auth/guards/auth.guard';

/** Square sales and refunds the worker gave up on, kept 30 days for replay. */
@Controller('api/sales/failed')
@UseGuards(AuthGuard, LocationGuard)
export class FailedSalesController {
  constructor(private readonly saleQueue: SaleQueue) {}

  /** Ids and the reason only: a sale job holds the whole Square payment. */
  @Get()
  @Roles('OWNER')
  async list() {
    const jobs = [...(await this.saleQueue.failedJobs('process-sale')), ...(await this.saleQueue.failedJobs('square-refund'))];
    const data = jobs.map((job) => ({
      jobId: job.id,
      squareId: job.data?.payload?.object?.payment?.id ?? job.data?.payload?.object?.refund?.id ?? null,
      error: workerError(job.failedReason),
      failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    }));
    return { success: true, data, count: data.length };
  }

  @Post('replay')
  @HttpCode(200)
  @Roles('OWNER')
  async replay() {
    return { success: true, data: { replayed: await this.saleQueue.replayFailedSales() } };
  }
}
