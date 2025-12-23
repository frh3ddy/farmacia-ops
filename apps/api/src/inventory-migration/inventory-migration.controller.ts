import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { InventoryMigrationService } from './inventory-migration.service';
import { Prisma } from '@prisma/client';
import {
  CutoverInput,
  CostApprovalRequest,
  CostApprovalResponse,
  MigrationResult,
  LocationPreview,
} from './types';

interface ExtractCostsRequest {
  locationIds: string[];
  costBasis: 'DESCRIPTION';
}

interface ApproveCostsRequest {
  cutoverId: string;
  approvedCosts: Array<{
    productId: string;
    cost: number;
    source: string;
    notes?: string | null;
  }>;
  rejectedProducts?: string[] | null;
}

interface InitiateCutoverRequest {
  cutoverDate: string; // ISO datetime
  locationIds: string[];
  costBasis: 'SQUARE_COST' | 'DESCRIPTION' | 'MANUAL_INPUT' | 'AVERAGE_COST';
  ownerApproved: boolean;
  approvalId?: string | null;
  manualCosts?: Array<{ productId: string; cost: number }> | null;
}

interface PreviewCutoverRequest {
  cutoverDate: string;
  locationIds: string[];
  costBasis: 'SQUARE_COST' | 'DESCRIPTION' | 'MANUAL_INPUT' | 'AVERAGE_COST';
  approvedCosts?: Array<{ productId: string; cost: number }> | null;
}

@Controller('admin/inventory/cutover')
export class InventoryMigrationController {
  constructor(
    private readonly migrationService: InventoryMigrationService,
  ) {}

  /**
   * Extract costs from product descriptions for owner review and approval
   * POST /admin/inventory/cutover/extract-costs
   */
  @Post('extract-costs')
  @HttpCode(HttpStatus.OK)
  async extractCostsForApproval(
    @Body() body: ExtractCostsRequest,
  ): Promise<{
    success: boolean;
    result: CostApprovalRequest;
    message: string;
  }> {
    // TODO: Add authentication guard (owner/admin only)
    try {
      if (body.costBasis !== 'DESCRIPTION') {
        throw new HttpException(
          {
            success: false,
            message: 'Cost basis must be DESCRIPTION for cost extraction',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.migrationService.extractCostsForMigration(
        body.locationIds,
        body.costBasis,
      );

      return {
        success: true,
        result: result,
        message: 'Cost extraction completed. Please review and approve.',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      throw new HttpException(
        {
          success: false,
          message: `Cost extraction failed: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Owner endpoint to approve or override extracted costs
   * POST /admin/inventory/cutover/approve-costs
   */
  @Post('approve-costs')
  @HttpCode(HttpStatus.OK)
  async approveExtractedCosts(
    @Body() body: ApproveCostsRequest,
  ): Promise<{
    success: boolean;
    approvedCount: number;
    rejectedCount: number;
    approvalId: string;
    message: string;
  }> {
    // TODO: Add authentication guard (owner/admin only)
    try {
      const approvedCosts = body.approvedCosts.map((ac) => ({
        productId: ac.productId,
        cost: new Prisma.Decimal(ac.cost),
        source: ac.source,
        notes: ac.notes || null,
      }));

      // Store approval in database
      await this.migrationService.storeCostApprovals(
        body.cutoverId,
        approvedCosts,
        null, // TODO: Get from auth context
      );

      return {
        success: true,
        approvedCount: approvedCosts.length,
        rejectedCount: body.rejectedProducts?.length || 0,
        approvalId: body.cutoverId,
        message: 'Costs approved successfully',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      throw new HttpException(
        {
          success: false,
          message: `Cost approval failed: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Owner endpoint to initiate inventory cutover and migration
   * POST /admin/inventory/cutover
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async initiateCutover(
    @Body() body: InitiateCutoverRequest,
  ): Promise<{
    success: boolean;
    result: MigrationResult;
    message: string;
  }> {
    // TODO: Add authentication guard (owner/admin only)
    try {
      const cutoverDate = new Date(body.cutoverDate);
      if (isNaN(cutoverDate.getTime())) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid cutover date format',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Build approved costs
      let approvedCosts: { productId: string; cost: Prisma.Decimal }[] = [];
      
      // If DESCRIPTION cost basis, retrieve from CostApproval table
      if (body.costBasis === 'DESCRIPTION' && body.approvalId) {
        approvedCosts = await this.migrationService.getCostApprovals(
          body.approvalId,
        );
      } else if (body.manualCosts) {
        // Use manual costs if provided
        for (const mc of body.manualCosts) {
          approvedCosts.push({
            productId: mc.productId,
            cost: new Prisma.Decimal(mc.cost),
          });
        }
      }

      const input: CutoverInput = {
        cutoverDate: cutoverDate,
        locationIds: body.locationIds,
        costBasis: body.costBasis,
        ownerApproved: body.ownerApproved,
        ownerApprovedAt: new Date(),
        ownerApprovedBy: null, // TODO: Get from auth context
        approvedCosts: approvedCosts.length > 0 ? approvedCosts : null,
      };

      const result = await this.migrationService.executeInventoryMigration(
        input,
        approvedCosts,
      );

      return {
        success: true,
        result: result,
        message: 'Inventory cutover completed successfully',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      // Check if it's a validation error
      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          success: false,
          message: `Cutover failed: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get status of cutover for a location or all locations
   * GET /admin/inventory/cutover/status
   */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  async getCutoverStatus(
    @Query('locationId') locationId?: string,
  ): Promise<{
    isLocked: boolean;
    cutoverDate?: string | null;
    lockedAt?: string | null;
    locations: Array<{
      locationId: string;
      locationName: string;
      isLocked: boolean;
      cutoverDate?: string | null;
    }>;
  }> {
    // TODO: Add authentication guard
    try {
      const status = await this.migrationService.getCutoverStatus(locationId);

      return {
        isLocked: status.isLocked,
        cutoverDate: status.cutoverDate?.toISOString() || null,
        lockedAt: status.lockedAt?.toISOString() || null,
        locations: status.locations.map((loc) => ({
          locationId: loc.locationId,
          locationName: loc.locationName,
          isLocked: loc.isLocked,
          cutoverDate: loc.cutoverDate?.toISOString() || null,
        })),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      throw new HttpException(
        {
          success: false,
          message: `Failed to get cutover status: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Preview what would be migrated without executing (dry run)
   * POST /admin/inventory/cutover/preview
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  async previewCutover(
    @Body() body: PreviewCutoverRequest,
  ): Promise<{
    locations: LocationPreview[];
    totalProducts: number;
    productsWithCost: number;
    productsMissingCost: number;
    estimatedOpeningBalances: number;
    warnings: Array<{
      productId?: string | null;
      locationId?: string | null;
      message: string;
      recommendation?: string | null;
    }>;
  }> {
    // TODO: Add authentication guard (owner/admin only)
    try {
      const cutoverDate = new Date(body.cutoverDate);
      if (isNaN(cutoverDate.getTime())) {
        throw new HttpException(
          {
            success: false,
            message: 'Invalid cutover date format',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const approvedCosts = body.approvedCosts
        ? body.approvedCosts.map((ac) => ({
            productId: ac.productId,
            cost: new Prisma.Decimal(ac.cost),
          }))
        : undefined;

      const input: CutoverInput = {
        cutoverDate: cutoverDate,
        locationIds: body.locationIds,
        costBasis: body.costBasis,
        ownerApproved: false, // Preview doesn't require approval
        approvedCosts: approvedCosts || null,
      };

      const preview = await this.migrationService.previewCutover(
        input,
        approvedCosts,
      );

      return {
        locations: preview.locations,
        totalProducts: preview.totalProducts,
        productsWithCost: preview.productsWithCost,
        productsMissingCost: preview.productsMissingCost,
        estimatedOpeningBalances: preview.estimatedOpeningBalances,
        warnings: preview.warnings,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      throw new HttpException(
        {
          success: false,
          message: `Preview failed: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

