import {
  Controller,
  Get,
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

      let agedBatches =
        await this.inventoryAgingService.classifyInventoryAging();

      // Filter by location if provided
      if (normalizedLocationId) {
        agedBatches = agedBatches.filter(
          (batch) => batch.batch.locationId === normalizedLocationId,
        );
      }

      // Filter by category if provided
      if (normalizedCategoryId) {
        agedBatches = agedBatches.filter(
          (batch) => batch.batch.product.categoryId === normalizedCategoryId,
        );
      }

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

      let agedBatches =
        await this.inventoryAgingService.classifyInventoryAging();

      // Filter by location if provided
      if (normalizedLocationId) {
        agedBatches = agedBatches.filter(
          (batch) => batch.batch.locationId === normalizedLocationId,
        );
      }

      // Filter by category if provided
      if (normalizedCategoryId) {
        agedBatches = agedBatches.filter(
          (batch) => batch.batch.product.categoryId === normalizedCategoryId,
        );
      }

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

      let agedBatches =
        await this.inventoryAgingService.classifyInventoryAging();

      // Filter by location if provided
      if (normalizedLocationId) {
        agedBatches = agedBatches.filter(
          (batch) => batch.batch.locationId === normalizedLocationId,
        );
      }

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

      let agedBatches =
        await this.inventoryAgingService.classifyInventoryAging();

      // Filter by category if provided
      if (normalizedCategoryId) {
        agedBatches = agedBatches.filter(
          (batch) => batch.batch.product.categoryId === normalizedCategoryId,
        );
      }

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
  ) {
    try {
      // Normalize empty strings to undefined
      const normalizedSeverity = severity?.trim() || undefined;
      const normalizedType = type?.trim() || undefined;
      const validSeverities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      const validTypes = ['AT_RISK', 'SLOW_MOVING_EXPENSIVE', 'OVERSTOCKED_CATEGORY'];
      const normalizedSeverityEnum = normalizedSeverity && validSeverities.includes(normalizedSeverity)
        ? (normalizedSeverity as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL')
        : undefined;
      const normalizedTypeEnum = normalizedType && validTypes.includes(normalizedType)
        ? (normalizedType as 'AT_RISK' | 'SLOW_MOVING_EXPENSIVE' | 'OVERSTOCKED_CATEGORY')
        : undefined;

      const agedBatches =
        await this.inventoryAgingService.classifyInventoryAging();

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
}

