import {
  Controller,
  Get,
  Query,
  Req,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { InventoryReportsService } from './inventory-reports.service';
import { AuthGuard, RoleGuard, LocationGuard, Roles } from '../auth/guards/auth.guard';

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
@UseGuards(AuthGuard, RoleGuard, LocationGuard)
export class InventoryReportsController {
  constructor(private readonly reportsService: InventoryReportsService) {}

  // --------------------------------------------------------------------------
  // COGS Report (Cost of Goods Sold) - OWNER, MANAGER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Get('cogs')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getCOGSReport(
    @Req() req: any,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('groupByCategory') groupByCategory?: string
  ) {
    try {
      const currentLocation = req.currentLocation;
      const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

      const report = await this.reportsService.getCOGSReport({
        locationId: targetLocationId,
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
  // Inventory Valuation Report - OWNER, MANAGER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Get('valuation')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getInventoryValuationReport(
    @Req() req: any,
    @Query('locationId') locationId?: string,
    @Query('productId') productId?: string
  ) {
    try {
      const currentLocation = req.currentLocation;
      const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

      const report = await this.reportsService.getInventoryValuationReport({
        locationId: targetLocationId,
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
  // Profit Margin Report - OWNER, MANAGER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Get('profit-margin')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getProfitMarginReport(
    @Req() req: any,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const currentLocation = req.currentLocation;
      const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

      const report = await this.reportsService.getProfitMarginReport({
        locationId: targetLocationId,
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
  // Adjustment Impact Report - OWNER, MANAGER
  // --------------------------------------------------------------------------
  @Get('adjustment-impact')
  @Roles('OWNER', 'MANAGER')
  async getAdjustmentImpactReport(
    @Req() req: any,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const currentLocation = req.currentLocation;
      const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

      const report = await this.reportsService.getAdjustmentImpactReport({
        locationId: targetLocationId,
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
  // Receiving Summary Report - OWNER, MANAGER
  // --------------------------------------------------------------------------
  @Get('receiving-summary')
  @Roles('OWNER', 'MANAGER')
  async getReceivingSummaryReport(
    @Req() req: any,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const currentLocation = req.currentLocation;
      const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

      const report = await this.reportsService.getReceivingSummaryReport({
        locationId: targetLocationId,
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
  // Profit & Loss Report (Income Statement) - OWNER, ACCOUNTANT
  // Includes: Revenue, COGS, Gross Profit, Operating Expenses, Net Profit
  // --------------------------------------------------------------------------
  @Get('profit-loss')
  @Roles('OWNER', 'ACCOUNTANT')
  async getProfitAndLossReport(
    @Req() req: any,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const currentLocation = req.currentLocation;
      const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

      const report = await this.reportsService.getProfitAndLossReport({
        locationId: targetLocationId,
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
  // Dashboard Summary (all key metrics in one call) - All authenticated users
  // --------------------------------------------------------------------------
  @Get('dashboard')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getDashboardSummary(
    @Req() req: any,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    try {
      const currentLocation = req.currentLocation;
      const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

      const parsedStartDate = startDate ? new Date(startDate) : undefined;
      const parsedEndDate = endDate ? new Date(endDate) : undefined;

      // Fetch all reports in parallel (including P&L for net profit)
      const [cogs, valuation, adjustments, receivings, profitLoss] = await Promise.all([
        this.reportsService.getCOGSReport({
          locationId: targetLocationId,
          startDate: parsedStartDate,
          endDate: parsedEndDate,
        }),
        this.reportsService.getInventoryValuationReport({ locationId: targetLocationId }),
        this.reportsService.getAdjustmentImpactReport({
          locationId: targetLocationId,
          startDate: parsedStartDate,
          endDate: parsedEndDate,
        }),
        this.reportsService.getReceivingSummaryReport({
          locationId: targetLocationId,
          startDate: parsedStartDate,
          endDate: parsedEndDate,
        }),
        this.reportsService.getProfitAndLossReport({
          locationId: targetLocationId,
          startDate: parsedStartDate,
          endDate: parsedEndDate,
        }),
      ]);

      return {
        success: true,
        data: {
          period: { startDate: parsedStartDate, endDate: parsedEndDate },
          locationId: targetLocationId,
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
