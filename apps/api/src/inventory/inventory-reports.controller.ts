import {
  Controller,
  Get,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InventoryReportsService } from './inventory-reports.service';

// Helper to extract error message
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getErrorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

@Controller('inventory/reports')
export class InventoryReportsController {
  constructor(private readonly reportsService: InventoryReportsService) {}

  // --------------------------------------------------------------------------
  // COGS Report (Cost of Goods Sold)
  // --------------------------------------------------------------------------
  @Get('cogs')
  async getCOGSReport(
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('groupByCategory') groupByCategory?: string
  ) {
    try {
      const report = await this.reportsService.getCOGSReport({
        locationId,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        groupByCategory: groupByCategory === 'true',
      });

      return {
        success: true,
        data: report,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get COGS report' },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Inventory Valuation Report
  // --------------------------------------------------------------------------
  @Get('valuation')
  async getInventoryValuationReport(
    @Query('locationId') locationId?: string,
    @Query('productId') productId?: string
  ) {
    try {
      const report = await this.reportsService.getInventoryValuationReport({
        locationId,
        productId,
      });

      return {
        success: true,
        data: report,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get valuation report' },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Profit Margin Report
  // --------------------------------------------------------------------------
  @Get('profit-margin')
  async getProfitMarginReport(
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const report = await this.reportsService.getProfitMarginReport({
        locationId,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      });

      return {
        success: true,
        data: report,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get profit margin report' },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Adjustment Impact Report
  // --------------------------------------------------------------------------
  @Get('adjustment-impact')
  async getAdjustmentImpactReport(
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const report = await this.reportsService.getAdjustmentImpactReport({
        locationId,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      });

      return {
        success: true,
        data: report,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get adjustment report' },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Receiving Summary Report
  // --------------------------------------------------------------------------
  @Get('receiving-summary')
  async getReceivingSummaryReport(
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const report = await this.reportsService.getReceivingSummaryReport({
        locationId,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      });

      return {
        success: true,
        data: report,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get receiving report' },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Profit & Loss Report (Income Statement)
  // Includes: Revenue, COGS, Gross Profit, Operating Expenses, Net Profit
  // --------------------------------------------------------------------------
  @Get('profit-loss')
  async getProfitAndLossReport(
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const report = await this.reportsService.getProfitAndLossReport({
        locationId,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      });

      return {
        success: true,
        data: report,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get P&L report' },
        getErrorStatus(error)
      );
    }
  }

  // --------------------------------------------------------------------------
  // Dashboard Summary (all key metrics in one call)
  // --------------------------------------------------------------------------
  @Get('dashboard')
  async getDashboardSummary(
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const parsedStartDate = startDate ? new Date(startDate) : undefined;
      const parsedEndDate = endDate ? new Date(endDate) : undefined;

      // Fetch all reports in parallel (including P&L for net profit)
      const [cogs, valuation, adjustments, receivings, profitLoss] = await Promise.all([
        this.reportsService.getCOGSReport({
          locationId,
          startDate: parsedStartDate,
          endDate: parsedEndDate,
        }),
        this.reportsService.getInventoryValuationReport({ locationId }),
        this.reportsService.getAdjustmentImpactReport({
          locationId,
          startDate: parsedStartDate,
          endDate: parsedEndDate,
        }),
        this.reportsService.getReceivingSummaryReport({
          locationId,
          startDate: parsedStartDate,
          endDate: parsedEndDate,
        }),
        this.reportsService.getProfitAndLossReport({
          locationId,
          startDate: parsedStartDate,
          endDate: parsedEndDate,
        }),
      ]);

      return {
        success: true,
        data: {
          period: { startDate: parsedStartDate, endDate: parsedEndDate },
          locationId,
          sales: {
            totalRevenue: cogs.summary.totalRevenue,
            totalCOGS: cogs.summary.totalCOGS,
            grossProfit: cogs.summary.grossProfit,
            grossMarginPercent: cogs.summary.grossMarginPercent,
            totalUnitsSold: cogs.summary.totalUnitsSold,
            totalSales: cogs.summary.totalSales,
          },
          inventory: {
            totalUnits: valuation.summary.totalUnits,
            totalValue: valuation.summary.totalValue,
            totalProducts: valuation.summary.totalProducts,
            averageCostPerUnit: valuation.summary.averageCostPerUnit,
            aging: valuation.agingSummary,
          },
          adjustments: {
            totalAdjustments: adjustments.summary.totalAdjustments,
            totalLoss: adjustments.summary.totalLoss,
            totalGain: adjustments.summary.totalGain,
            netImpact: adjustments.summary.netImpact,
          },
          receivings: {
            totalReceivings: receivings.summary.totalReceivings,
            totalQuantity: receivings.summary.totalQuantity,
            totalCost: receivings.summary.totalCost,
          },
          // Operating Expenses (rent, payroll, utilities, etc.)
          operatingExpenses: {
            total: profitLoss.operatingExpenses.total,
            byType: profitLoss.operatingExpenses.byType,
            shrinkage: profitLoss.operatingExpenses.shrinkage,
          },
          // Net Profit (after all expenses)
          netProfit: {
            amount: profitLoss.netProfit.amount,
            marginPercent: profitLoss.netProfit.marginPercent,
          },
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: getErrorMessage(error) || 'Failed to get dashboard' },
        getErrorStatus(error)
      );
    }
  }
}
