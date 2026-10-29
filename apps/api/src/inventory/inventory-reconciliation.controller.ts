import {
  Controller,
  Get,
  Query,
  Param,
  HttpException,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InventoryReconciliationService } from './inventory-reconciliation.service';
import { AuthGuard, LocationGuard, Roles, assertLocationAccess, GuardedRequest } from '../auth/guards/auth.guard';

@Controller('inventory/reconciliation')
@UseGuards(AuthGuard, LocationGuard)
@Roles('OWNER', 'MANAGER')  // Reconciliation requires OWNER or MANAGER role
export class InventoryReconciliationController {
  constructor(
    private readonly reconciliationService: InventoryReconciliationService,
  ) {}

  /**
   * Get consumption summary for a product over a time period
   */
  @Get('consumption/:productId')
  async getConsumptionSummary(
    @Param('productId') productId: string,
    @Query('locationId') locationId: string,
    @Query('startDate') startDateStr: string,
    @Query('endDate') endDateStr: string,
  ) {
    if (!locationId) {
      throw new HttpException(
        { success: false, message: 'locationId query parameter is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Default to last 30 days if no dates provided
    const endDate = endDateStr ? new Date(endDateStr) : new Date();
    const startDate = startDateStr
      ? new Date(startDateStr)
      : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new HttpException(
        { success: false, message: 'La fecha no es válida' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.reconciliationService.getConsumptionSummary(
      productId,
      locationId,
      startDate,
      endDate,
    );

    return {
      success: true,
      summary: {
        ...result,
        totalCostConsumed: result.totalCostConsumed.toString(),
        averageUnitCost: result.averageUnitCost.toString(),
        periodStart: result.periodStart.toISOString(),
        periodEnd: result.periodEnd.toISOString(),
      },
    };
  }

  /**
   * Get consumption details for a specific sale item
   * Shows which inventory batches were consumed (FIFO audit trail)
   */
  @Get('sale-item/:saleItemId')
  async getSaleItemConsumption(@Param('saleItemId') saleItemId: string, @Req() req: GuardedRequest) {
    const consumptions = await this.reconciliationService.getSaleItemConsumption(saleItemId);
    // No locationId in the request for LocationGuard to check — check the batches'.
    new Set(consumptions.map((c) => c.batchLocationId)).forEach((locationId) => assertLocationAccess(req, locationId));

    return {
      success: true,
      saleItemId,
      consumptions: consumptions.map(c => ({
        ...c,
        unitCost: c.unitCost.toString(),
        totalCost: c.totalCost.toString(),
        batchReceivedAt: c.batchReceivedAt.toISOString(),
        consumedAt: c.consumedAt.toISOString(),
      })),
      totalBatches: consumptions.length,
      totalQuantity: consumptions.reduce((sum, c) => sum + c.quantityConsumed, 0),
    };
  }
}
