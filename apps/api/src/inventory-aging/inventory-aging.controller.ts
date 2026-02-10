import {
  Controller,
  Get,
  Post,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InventoryAgingService } from './inventory-aging.service';

@Controller('inventory/aging')
export class InventoryAgingController {
  constructor(
    private readonly inventoryAgingService: InventoryAgingService,
  ) {}

  @Get('summary')
  async getAgingSummary(
    @Query('locationId') locationId?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    try {
      // Normalize empty strings to undefined
      const normalizedLocationId = locationId?.trim() || undefined;
      const normalizedCategoryId = categoryId?.trim() || undefined;

      // Filters are now pushed to the database query for efficiency
      const agedBatches =
        await this.inventoryAgingService.classifyInventoryAging(
          normalizedLocationId,
          normalizedCategoryId,
        );

      const summary =
        this.inventoryAgingService.aggregateAgingSummary(agedBatches);

      return {
        buckets: summary.buckets.map((bucket) => ({
          bucket: {
            label: bucket.bucket.label,
            min: bucket.bucket.min,
            max: bucket.bucket.max === Infinity ? null : bucket.bucket.max,
          },
          cashValue: bucket.cashValue.toNumber(),
          unitCount: bucket.unitCount,
          percentageOfTotal: bucket.percentageOfTotal,
        })),
        totalCashTiedUp: summary.totalCashTiedUp.toNumber(),
        totalUnits: summary.totalUnits,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('[INVENTORY_AGING] Error getting summary:', errorMessage);
      throw new HttpException(
        {
          success: false,
          message: `Failed to get aging summary: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('products')
  async getProductAging(
    @Query('locationId') locationId?: string,
    @Query('categoryId') categoryId?: string,
    @Query('riskLevel') riskLevel?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    try {
      // Normalize empty strings to undefined
      const normalizedLocationId = locationId?.trim() || undefined;
      const normalizedCategoryId = categoryId?.trim() || undefined;
      const normalizedRiskLevel = riskLevel?.trim() || undefined;
      const validRiskLevels = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      const normalizedRiskLevelEnum = normalizedRiskLevel && validRiskLevels.includes(normalizedRiskLevel)
        ? (normalizedRiskLevel as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL')
        : undefined;

      // Filters are now pushed to the database query for efficiency
      const agedBatches =
        await this.inventoryAgingService.classifyInventoryAging(
          normalizedLocationId,
          normalizedCategoryId,
        );

      let productAnalyses =
        this.inventoryAgingService.analyzeProductAging(agedBatches);

      // Filter by risk level if provided
      if (normalizedRiskLevelEnum) {
        productAnalyses = productAnalyses.filter(
          (product) => product.riskLevel === normalizedRiskLevelEnum,
        );
      }

      const total = productAnalyses.length;

      // Apply pagination
      const limitNum = limit ? parseInt(limit, 10) : 100;
      const offsetNum = offset ? parseInt(offset, 10) : 0;
      const maxLimit = 500;
      const actualLimit = Math.min(limitNum, maxLimit);

      const paginatedAnalyses = productAnalyses.slice(
        offsetNum,
        offsetNum + actualLimit,
      );

      return {
        products: paginatedAnalyses.map((product) => ({
          productId: product.productId,
          productName: product.productName,
          categoryName: product.categoryName,
          totalCashTiedUp: product.totalCashTiedUp.toNumber(),
          totalUnits: product.totalUnits,
          oldestBatchAge: product.oldestBatchAge,
          bucketDistribution: product.bucketDistribution.map((bucket) => ({
            bucket: {
              label: bucket.bucket.label,
              min: bucket.bucket.min,
              max: bucket.bucket.max === Infinity ? null : bucket.bucket.max,
            },
            cashValue: bucket.cashValue.toNumber(),
            unitCount: bucket.unitCount,
            percentageOfTotal: bucket.percentageOfTotal,
          })),
          riskLevel: product.riskLevel,
        })),
        total: total,
        limit: actualLimit,
        offset: offsetNum,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('[INVENTORY_AGING] Error getting product aging:', errorMessage);
      throw new HttpException(
        {
          success: false,
          message: `Failed to get product aging: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('location')
  async getLocationAging(@Query('locationId') locationId?: string) {
    try {
      // Normalize empty strings to undefined
      const normalizedLocationId = locationId?.trim() || undefined;

      // Filter pushed to database query for efficiency
      const agedBatches =
        await this.inventoryAgingService.classifyInventoryAging(
          normalizedLocationId,
        );

      const locationAnalyses =
        this.inventoryAgingService.analyzeLocationAging(agedBatches);

      return {
        locations: locationAnalyses.map((location) => ({
          locationId: location.locationId,
          locationName: location.locationName,
          totalCashTiedUp: location.totalCashTiedUp.toNumber(),
          totalUnits: location.totalUnits,
          bucketDistribution: location.bucketDistribution.map((bucket) => ({
            bucket: {
              label: bucket.bucket.label,
              min: bucket.bucket.min,
              max: bucket.bucket.max === Infinity ? null : bucket.bucket.max,
            },
            cashValue: bucket.cashValue.toNumber(),
            unitCount: bucket.unitCount,
            percentageOfTotal: bucket.percentageOfTotal,
          })),
          atRiskProducts: location.atRiskProducts,
        })),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('[INVENTORY_AGING] Error getting location aging:', errorMessage);
      throw new HttpException(
        {
          success: false,
          message: `Failed to get location aging: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('category')
  async getCategoryAging(@Query('categoryId') categoryId?: string) {
    try {
      // Normalize empty strings to undefined
      const normalizedCategoryId = categoryId?.trim() || undefined;

      // Filter pushed to database query for efficiency
      const agedBatches =
        await this.inventoryAgingService.classifyInventoryAging(
          undefined, // locationId
          normalizedCategoryId,
        );

      const categoryAnalyses =
        this.inventoryAgingService.analyzeCategoryAging(agedBatches);

      return {
        categories: categoryAnalyses.map((category) => ({
          categoryId: category.categoryId,
          categoryName: category.categoryName,
          totalCashTiedUp: category.totalCashTiedUp.toNumber(),
          totalUnits: category.totalUnits,
          bucketDistribution: category.bucketDistribution.map((bucket) => ({
            bucket: {
              label: bucket.bucket.label,
              min: bucket.bucket.min,
              max: bucket.bucket.max === Infinity ? null : bucket.bucket.max,
            },
            cashValue: bucket.cashValue.toNumber(),
            unitCount: bucket.unitCount,
            percentageOfTotal: bucket.percentageOfTotal,
          })),
          averageAge: category.averageAge,
        })),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('[INVENTORY_AGING] Error getting category aging:', errorMessage);
      throw new HttpException(
        {
          success: false,
          message: `Failed to get category aging: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('signals')
  async getActionableSignals(
    @Query('severity') severity?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('locationId') locationId?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    try {
      // Normalize empty strings to undefined
      const normalizedSeverity = severity?.trim() || undefined;
      const normalizedType = type?.trim() || undefined;
      const normalizedLocationId = locationId?.trim() || undefined;
      const normalizedCategoryId = categoryId?.trim() || undefined;
      const validSeverities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      const validTypes = ['AT_RISK', 'SLOW_MOVING_EXPENSIVE', 'OVERSTOCKED_CATEGORY'];
      const normalizedSeverityEnum = normalizedSeverity && validSeverities.includes(normalizedSeverity)
        ? (normalizedSeverity as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL')
        : undefined;
      const normalizedTypeEnum = normalizedType && validTypes.includes(normalizedType)
        ? (normalizedType as 'AT_RISK' | 'SLOW_MOVING_EXPENSIVE' | 'OVERSTOCKED_CATEGORY')
        : undefined;

      // Filters pushed to database query - uses cache if available
      const agedBatches =
        await this.inventoryAgingService.classifyInventoryAging(
          normalizedLocationId,
          normalizedCategoryId,
        );

      const productAnalyses =
        this.inventoryAgingService.analyzeProductAging(agedBatches);
      const categoryAnalyses =
        this.inventoryAgingService.analyzeCategoryAging(agedBatches);
      const locationAnalyses =
        this.inventoryAgingService.analyzeLocationAging(agedBatches);

      let signals = this.inventoryAgingService.generateActionableSignals(
        productAnalyses,
        categoryAnalyses,
        locationAnalyses,
      );

      // Filter by severity if provided
      if (normalizedSeverityEnum) {
        signals = signals.filter((signal) => signal.severity === normalizedSeverityEnum);
      }

      // Filter by type if provided
      if (normalizedTypeEnum) {
        signals = signals.filter((signal) => signal.type === normalizedTypeEnum);
      }

      const total = signals.length;

      // Apply limit
      const limitNum = limit ? parseInt(limit, 10) : 50;
      const maxLimit = 200;
      const actualLimit = Math.min(limitNum, maxLimit);

      const limitedSignals = signals.slice(0, actualLimit);

      return {
        signals: limitedSignals.map((signal) => ({
          type: signal.type,
          severity: signal.severity,
          entityType: signal.entityType,
          entityId: signal.entityId,
          entityName: signal.entityName,
          message: signal.message,
          recommendedActions: signal.recommendedActions,
          cashAtRisk: signal.cashAtRisk?.toNumber() || null,
        })),
        total: total,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('[INVENTORY_AGING] Error getting signals:', errorMessage);
      throw new HttpException(
        {
          success: false,
          message: `Failed to get actionable signals: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('expiring')
  async getExpiringProducts(
    @Query('locationId') locationId?: string,
    @Query('withinDays') withinDays?: string,
    @Query('includeExpired') includeExpired?: string,
  ) {
    try {
      const normalizedLocationId = locationId?.trim() || undefined;
      const days = withinDays ? parseInt(withinDays, 10) : 90;
      const expired = includeExpired !== 'false'; // default true

      const analyses = await this.inventoryAgingService.getExpiringProducts(
        normalizedLocationId,
        days,
        expired,
      );

      return {
        products: analyses.map((product) => ({
          productId: product.productId,
          productName: product.productName,
          sku: product.sku,
          totalUnits: product.totalUnits,
          totalCashAtRisk: product.totalCashAtRisk.toNumber(),
          batchCount: product.batchCount,
          expiredCount: product.expiredCount,
          soonestExpiryDate: product.soonestExpiryDate,
          soonestDaysUntilExpiry: product.soonestDaysUntilExpiry,
          severity: product.severity,
          batches: product.batches.map((batch) => ({
            batchId: batch.batchId,
            receivingId: batch.receivingId,
            quantity: batch.quantity,
            unitCost: batch.unitCost.toNumber(),
            cashValue: batch.cashValue.toNumber(),
            expiryDate: batch.expiryDate,
            daysUntilExpiry: batch.daysUntilExpiry,
            isExpired: batch.isExpired,
            batchNumber: batch.batchNumber,
            supplierName: batch.supplierName,
            receivedAt: batch.receivedAt,
          })),
        })),
        total: analyses.length,
        summary: {
          totalProducts: analyses.length,
          totalExpiredBatches: analyses.reduce((sum, p) => sum + p.expiredCount, 0),
          totalCashAtRisk: analyses
            .reduce((sum, p) => sum + p.totalCashAtRisk.toNumber(), 0),
          criticalCount: analyses.filter((p) => p.severity === 'CRITICAL').length,
          highCount: analyses.filter((p) => p.severity === 'HIGH').length,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('[INVENTORY_AGING] Error getting expiring products:', errorMessage);
      throw new HttpException(
        {
          success: false,
          message: `Failed to get expiring products: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('clear-cache')
  async clearCache(
    @Query('locationId') locationId?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    try {
      const normalizedLocationId = locationId?.trim() || undefined;
      const normalizedCategoryId = categoryId?.trim() || undefined;

      this.inventoryAgingService.clearAgingCache(
        normalizedLocationId,
        normalizedCategoryId,
      );

      return {
        success: true,
        message: normalizedLocationId || normalizedCategoryId
          ? `Cache cleared for location=${normalizedLocationId || 'all'}, category=${normalizedCategoryId || 'all'}`
          : 'All aging cache cleared',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error('[INVENTORY_AGING] Error clearing cache:', errorMessage);
      throw new HttpException(
        {
          success: false,
          message: `Failed to clear cache: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

