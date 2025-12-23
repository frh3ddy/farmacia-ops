import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Param,
  HttpCode,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { InventoryMigrationService } from './inventory-migration.service';
import { SupplierService } from './supplier.service';
import { PrismaService } from '../prisma/prisma.service';
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
  batchSize?: number | string | null;
  extractionSessionId?: string | null; // For continuing batch extraction
}

interface ApproveCostsRequest {
  cutoverId: string;
  approvedCosts: Array<{
    productId: string;
    cost: number;
    source: string;
    notes?: string | null;
    supplierId?: string | null;
    supplierName?: string | null;
    isPreferred?: boolean;
  }>;
  entriesToAddToHistory?: Array<{
    productId: string;
    supplierName: string;
    supplierId?: string | null;
    cost: number;
    effectiveAt?: string | null; // ISO datetime, defaults to cutover date
  }> | null;
  rejectedProducts?: string[] | null;
  effectiveAt?: string | null; // ISO datetime for cost history
}

interface InitiateCutoverRequest {
  cutoverDate: string; // ISO datetime
  locationIds: string[];
  costBasis: 'SQUARE_COST' | 'DESCRIPTION' | 'MANUAL_INPUT' | 'AVERAGE_COST';
  ownerApproved: boolean;
  approvalId?: string | null;
  manualCosts?: Array<{ productId: string; cost: number }> | null;
  batchSize?: number | string | null; // Number of items per batch (can be number or string from form)
  cutoverId?: string | null; // For continuing existing migration
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
    private readonly supplierService: SupplierService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Suggest suppliers by search term
   * GET /admin/inventory/suppliers/suggest?q={searchTerm}
   */
  @Get('suppliers/suggest')
  @HttpCode(HttpStatus.OK)
  async suggestSuppliers(
    @Query('q') searchTerm?: string,
    @Query('limit') limit?: string,
  ): Promise<{
    success: boolean;
    suppliers: Array<{
      id: string;
      name: string;
      contactInfo: string | null;
    }>;
  }> {
    try {
      const limitNum = limit ? parseInt(limit, 10) : 10;
      const suppliers = await this.supplierService.suggestSuppliers(
        searchTerm || '',
        limitNum,
      );

      return {
        success: true,
        suppliers: suppliers,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        {
          success: false,
          message: `Failed to suggest suppliers: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get all suppliers
   * GET /admin/inventory/suppliers
   */
  @Get('suppliers')
  @HttpCode(HttpStatus.OK)
  async getAllSuppliers(): Promise<{
    success: boolean;
    suppliers: Array<{
      id: string;
      name: string;
      initials: string | null;
      contactInfo: string | null;
      isActive: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
  }> {
    try {
      const suppliers = await this.prisma.supplier.findMany({
        orderBy: { name: 'asc' },
      });

      return {
        success: true,
        suppliers: suppliers.map(s => ({
          id: s.id,
          name: s.name,
          initials: (s as any).initials,
          contactInfo: (s as any).contactInfo,
          isActive: (s as any).isActive,
          createdAt: (s as any).createdAt.toISOString(),
          updatedAt: (s as any).updatedAt.toISOString(),
        })),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        {
          success: false,
          message: `Failed to get suppliers: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Update a supplier
   * POST /admin/inventory/cutover/suppliers/:id/update
   */
  @Post('suppliers/:id/update')
  @HttpCode(HttpStatus.OK)
  async updateSupplier(
    @Param('id') id: string,
    @Body() body: { name?: string; initials?: string | null; contactInfo?: string | null; isActive?: boolean },
  ): Promise<{
    success: boolean;
    supplier: {
      id: string;
      name: string;
      initials: string | null;
      contactInfo: string | null;
      isActive: boolean;
    };
  }> {
    try {
      const updateData: any = {};
      if (body.name !== undefined) updateData.name = body.name.trim();
      if (body.initials !== undefined) updateData.initials = body.initials?.trim() || null;
      if (body.contactInfo !== undefined) updateData.contactInfo = body.contactInfo?.trim() || null;
      if (body.isActive !== undefined) updateData.isActive = body.isActive;

      await this.prisma.supplier.update({
        where: { id },
        data: updateData as any,
      });

      const supplier = await this.prisma.supplier.findUnique({
        where: { id },
      });

      if (!supplier) {
        throw new HttpException(
          {
            success: false,
            message: 'Supplier not found',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        supplier: {
          id: supplier.id,
          name: supplier.name,
          initials: (supplier as any).initials,
          contactInfo: (supplier as any).contactInfo,
          isActive: (supplier as any).isActive,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        {
          success: false,
          message: `Failed to update supplier: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Create a new supplier
   * POST /admin/inventory/suppliers
   */
  @Post('suppliers')
  @HttpCode(HttpStatus.OK)
  async createSupplier(
    @Body() body: { name: string; initials?: string | null; contactInfo?: string | null },
  ): Promise<{
    success: boolean;
    supplier: {
      id: string;
      name: string;
      initials: string | null;
      contactInfo: string | null;
      isActive: boolean;
    };
  }> {
    try {
      const supplier = await this.supplierService.findOrCreateSupplier(
        body.name,
      );

      // Update initials and contact info if provided
      const updateData: any = {};
      if (body.initials !== undefined) updateData.initials = body.initials?.trim() || null;
      if (body.contactInfo !== undefined) updateData.contactInfo = body.contactInfo?.trim() || null;

      if (Object.keys(updateData).length > 0) {
        await this.prisma.supplier.update({
          where: { id: supplier.id },
          data: updateData,
        });
      }

      const updatedSupplier = await this.prisma.supplier.findUnique({
        where: { id: supplier.id },
      });

      if (!updatedSupplier) {
        throw new HttpException(
          {
            success: false,
            message: 'Supplier not found after creation',
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return {
        success: true,
        supplier: {
          id: updatedSupplier.id,
          name: updatedSupplier.name,
          initials: (updatedSupplier as any).initials,
          contactInfo: (updatedSupplier as any).contactInfo,
          isActive: (updatedSupplier as any).isActive,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        {
          success: false,
          message: `Failed to create supplier: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Delete (deactivate) a supplier
   * POST /admin/inventory/cutover/suppliers/:id/delete
   */
  @Post('suppliers/:id/delete')
  @HttpCode(HttpStatus.OK)
  async deleteSupplier(
    @Param('id') id: string,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      // Soft delete by setting isActive to false
      await this.prisma.supplier.update({
        where: { id },
        data: { isActive: false } as any,
      });

      return {
        success: true,
        message: 'Supplier deactivated successfully',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        {
          success: false,
          message: `Failed to delete supplier: ${errorMessage}`,
          error: errorMessage,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

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

      // Validate and normalize batch size
      let batchSize: number | null = null;
      if (body.batchSize != null) {
        if (typeof body.batchSize === 'number' && body.batchSize > 0) {
          batchSize = body.batchSize;
        } else if (typeof body.batchSize === 'string') {
          const trimmed = body.batchSize.trim();
          if (trimmed !== '') {
            const parsed = parseInt(trimmed, 10);
            if (!isNaN(parsed) && parsed > 0) {
              batchSize = parsed;
            }
          }
        }
      }

      const result = await this.migrationService.extractCostsForMigration(
        body.locationIds,
        body.costBasis,
        batchSize,
        body.extractionSessionId || null,
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
        supplierId: ac.supplierId || null,
        supplierName: ac.supplierName || null,
        isPreferred: ac.isPreferred || false,
      }));

      // Parse effective date if provided
      const effectiveAt = body.effectiveAt
        ? new Date(body.effectiveAt)
        : null;

      // Process entries to add to supplier history
      const entriesToAddToHistory = body.entriesToAddToHistory
        ? body.entriesToAddToHistory.map((entry) => ({
            productId: entry.productId,
            supplierName: entry.supplierName,
            supplierId: entry.supplierId || null,
            cost: entry.cost,
            effectiveAt: entry.effectiveAt
              ? new Date(entry.effectiveAt)
              : undefined, // undefined means use default (one week ago)
          }))
        : null;

      // Store approval in database (includes supplier creation and cost history)
      await this.migrationService.storeCostApprovals(
        body.cutoverId,
        approvedCosts,
        null, // TODO: Get from auth context
        effectiveAt,
        entriesToAddToHistory,
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
   * Continue batch migration
   * POST /admin/inventory/cutover/continue
   */
  @Post('continue')
  @HttpCode(HttpStatus.OK)
  async continueCutover(
    @Body() body: { cutoverId: string },
  ): Promise<{
    success: boolean;
    result: MigrationResult;
    message: string;
  }> {
    try {
      // Get cutover record to retrieve approved costs
      const cutoverRecord = await this.prisma.cutover.findUnique({
        where: { id: body.cutoverId },
      });
      
      if (!cutoverRecord) {
        throw new HttpException(
          {
            success: false,
            message: 'Cutover not found',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      // Reconstruct approved costs from result or approvalId
      let approvedCosts: { productId: string; cost: Prisma.Decimal }[] = [];
      const result = cutoverRecord.result as any;
      if (result?.approvedCosts) {
        approvedCosts = result.approvedCosts.map((ac: any) => ({
          productId: ac.productId,
          cost: new Prisma.Decimal(ac.cost),
        }));
      } else if (cutoverRecord.costBasis === 'DESCRIPTION') {
        // Try to get from CostApproval table
        approvedCosts = await this.migrationService.getCostApprovals(body.cutoverId);
      }

      const migrationResult = await this.migrationService.continueBatchMigration(
        body.cutoverId,
        approvedCosts,
      );

      return {
        success: true,
        result: migrationResult,
        message: migrationResult.isComplete
          ? 'Migration completed successfully'
          : `Batch ${migrationResult.currentBatch}/${migrationResult.totalBatches} completed`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        {
          success: false,
          message: `Failed to continue migration: ${errorMessage}`,
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

      // Validate and normalize batch size
      let batchSize: number | null = null;
      if (body.batchSize != null) {
        if (typeof body.batchSize === 'number' && body.batchSize > 0) {
          batchSize = body.batchSize;
        } else if (typeof body.batchSize === 'string') {
          const trimmed = body.batchSize.trim();
          if (trimmed !== '') {
            const parsed = parseInt(trimmed, 10);
            if (!isNaN(parsed) && parsed > 0) {
              batchSize = parsed;
            }
          }
        }
      }

      const result = await this.migrationService.executeInventoryMigration(
        input,
        approvedCosts,
        batchSize,
        body.cutoverId || null,
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

