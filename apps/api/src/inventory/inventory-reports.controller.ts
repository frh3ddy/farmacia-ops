import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { EmployeeRole } from '@prisma/client';
import { InventoryReportsService } from './inventory-reports.service';
import { parseDateParam } from './business-date';
import { AuthGuard, LocationGuard, Roles, assertLocationAccess, GuardedRequest, RoleGuardedRequest } from '../auth/guards/auth.guard';

const PROFIT_LOSS_ROLES: EmployeeRole[] = ['OWNER', 'ACCOUNTANT'];

@Controller('inventory/reports')
@UseGuards(AuthGuard, LocationGuard)
export class InventoryReportsController {
  constructor(private readonly reportsService: InventoryReportsService) {}

  // --------------------------------------------------------------------------
  // COGS Report (Cost of Goods Sold) - OWNER, MANAGER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Get('cogs')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getCOGSReport(
    @Req() req: RoleGuardedRequest,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('groupByCategory') groupByCategory?: string
  ) {
    const currentLocation = req.currentLocation;
    const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

    const report = await this.reportsService.getCOGSReport({
      locationId: targetLocationId,
      startDate: parseDateParam(startDate, 'startDate', 'start'),
      endDate: parseDateParam(endDate, 'endDate', 'end'),
      groupByCategory: groupByCategory === 'true',
    });

    return {
      success: true,
      data: report,
    };
  }

  // --------------------------------------------------------------------------
  // Inventory Valuation Report - OWNER, MANAGER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Get('valuation')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getInventoryValuationReport(
    @Req() req: RoleGuardedRequest,
    @Query('locationId') locationId?: string,
    @Query('productId') productId?: string
  ) {
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
  }

  // --------------------------------------------------------------------------
  // Profit Margin Report - OWNER, MANAGER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Get('profit-margin')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getProfitMarginReport(
    @Req() req: RoleGuardedRequest,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    const currentLocation = req.currentLocation;
    const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

    const report = await this.reportsService.getProfitMarginReport({
      locationId: targetLocationId,
      startDate: parseDateParam(startDate, 'startDate', 'start'),
      endDate: parseDateParam(endDate, 'endDate', 'end'),
    });

    return {
      success: true,
      data: report,
    };
  }

  // --------------------------------------------------------------------------
  // Adjustment Impact Report - OWNER, MANAGER
  // --------------------------------------------------------------------------
  @Get('adjustment-impact')
  @Roles('OWNER', 'MANAGER')
  async getAdjustmentImpactReport(
    @Req() req: RoleGuardedRequest,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    const currentLocation = req.currentLocation;
    const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

    const report = await this.reportsService.getAdjustmentImpactReport({
      locationId: targetLocationId,
      startDate: parseDateParam(startDate, 'startDate', 'start'),
      endDate: parseDateParam(endDate, 'endDate', 'end'),
    });

    return {
      success: true,
      data: report,
    };
  }

  // --------------------------------------------------------------------------
  // Receiving Summary Report - OWNER, MANAGER
  // --------------------------------------------------------------------------
  @Get('receiving-summary')
  @Roles('OWNER', 'MANAGER')
  async getReceivingSummaryReport(
    @Req() req: RoleGuardedRequest,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    const currentLocation = req.currentLocation;
    const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

    const report = await this.reportsService.getReceivingSummaryReport({
      locationId: targetLocationId,
      startDate: parseDateParam(startDate, 'startDate', 'start'),
      endDate: parseDateParam(endDate, 'endDate', 'end'),
    });

    return {
      success: true,
      data: report,
    };
  }

  // --------------------------------------------------------------------------
  // Profit & Loss Report (Income Statement) - OWNER, ACCOUNTANT
  // Includes: Revenue, COGS, Gross Profit, Operating Expenses, Net Profit
  // --------------------------------------------------------------------------
  @Get('profit-loss')
  @Roles(...PROFIT_LOSS_ROLES)
  async getProfitAndLossReport(
    @Req() req: RoleGuardedRequest,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    const currentLocation = req.currentLocation;
    const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

    const report = await this.reportsService.getProfitAndLossReport({
      locationId: targetLocationId,
      startDate: parseDateParam(startDate, 'startDate', 'start'),
      endDate: parseDateParam(endDate, 'endDate', 'end'),
    });

    return {
      success: true,
      data: report,
    };
  }

  // --------------------------------------------------------------------------
  // Dashboard Summary (all key metrics in one call) - All authenticated users;
  // net profit and operating expenses only for OWNER, ACCOUNTANT
  // --------------------------------------------------------------------------
  @Get('dashboard')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')
  async getDashboardSummary(
    @Req() req: RoleGuardedRequest,
    @Query('locationId') locationId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string
  ) {
    const currentLocation = req.currentLocation;
    const targetLocationId = currentLocation.role === 'OWNER' ? locationId : currentLocation.locationId;

    const parsedStartDate = parseDateParam(startDate, 'startDate', 'start');
    const parsedEndDate = parseDateParam(endDate, 'endDate', 'end');

    // Net profit and expenses (payroll, rent) only for the roles that may open
    // the P&L report itself.
    const canSeeProfitLoss = PROFIT_LOSS_ROLES.includes(currentLocation.role);

    // Fetch all reports in parallel
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
      canSeeProfitLoss
        ? this.reportsService.getProfitAndLossReport({
            locationId: targetLocationId,
            startDate: parsedStartDate,
            endDate: parsedEndDate,
          })
        : undefined,
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
        ...(profitLoss && {
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
        }),
      },
    };
  }

  // --------------------------------------------------------------------------
  // Batch Detail - Full history for a single FIFO batch
  // --------------------------------------------------------------------------
  @Get('batch/:batchId')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async getBatchDetail(@Param('batchId') batchId: string, @Req() req: GuardedRequest) {
    const detail = await this.reportsService.getBatchDetail(batchId);

    if (!detail) {
      throw new NotFoundException(`Batch ${batchId} not found`);
    }
    // No locationId in the request for LocationGuard to check — check the batch's.
    assertLocationAccess(req, detail.locationId);

    return {
      success: true,
      data: detail,
    };
  }

  /** The latest nightly integrity run (apps/worker/src/integrity-run.ts), for the web banner; null before the first run. */
  @Get('integrity')
  @Roles('OWNER')
  async getLatestIntegrityRun() {
    return { success: true, data: await this.reportsService.getLatestIntegrityRun() };
  }
}
