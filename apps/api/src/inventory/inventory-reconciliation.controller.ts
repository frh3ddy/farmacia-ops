import {
  Controller,
  Get,
  Query,
  Param,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { InventoryReconciliationService } from './inventory-reconciliation.service';
import { AuthGuard, RoleGuard, LocationGuard, Roles } from '../auth/guards/auth.guard';

@Controller('inventory/reconciliation')
@UseGuards(AuthGuard, RoleGuard, LocationGuard)
@Roles('OWNER', 'MANAGER')  // Reconciliation requires OWNER or MANAGER role
export class InventoryReconciliationController {
  constructor(
    private readonly reconciliationService: InventoryReconciliationService,
  ) {}

  /**
   * Reconcile inventory for a specific product at a location
   * Compares current inventory with consumption history
   */
  @Get('product/:productId')
  async reconcileProduct(
    @Param('productId') productId: string,
    @Query('locationId') locationId: string,
  ) {
    if (!locationId) {
      throw new HttpException(
        { success: false, message: 'locationId query parameter is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.reconciliationService.reconcileProduct(
        productId,
        locationId,
      );

      return {
        success: true,
        reconciliation: {
          ...result,
          currentValue: result.currentValue.toString(),
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: `Reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Reconcile all products at a location
   */
  @Get('location/:locationId')
  async reconcileLocation(@Param('locationId') locationId: string) {
    try {
      const result = await this.reconciliationService.reconcileLocation(locationId);

      return {
        success: true,
        reconciliation: {
          ...result,
          totalCurrentValue: result.totalCurrentValue.toString(),
          totalExpectedValue: result.totalExpectedValue.toString(),
          valueDiscrepancy: result.valueDiscrepancy.toString(),
          products: result.products.map(p => ({
            ...p,
            currentValue: p.currentValue.toString(),
          })),
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: `Reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

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
        { success: false, message: 'Invalid date format' },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
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
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: `Failed to get consumption summary: ${error instanceof Error ? error.message : String(error)}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get consumption details for a specific sale item
   * Shows which inventory batches were consumed (FIFO audit trail)
   */
  @Get('sale-item/:saleItemId')
  async getSaleItemConsumption(@Param('saleItemId') saleItemId: string) {
    try {
      const consumptions = await this.reconciliationService.getSaleItemConsumption(
        saleItemId,
      );

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
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: `Failed to get sale item consumption: ${error instanceof Error ? error.message : String(error)}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Verify FIFO compliance for a sale
   * Checks that inventory was consumed in correct chronological order
   */
  @Get('verify-fifo/:saleId')
  async verifyFIFOCompliance(@Param('saleId') saleId: string) {
    try {
      const result = await this.reconciliationService.verifyFIFOCompliance(saleId);

      return {
        success: true,
        saleId,
        ...result,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: `FIFO verification failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
