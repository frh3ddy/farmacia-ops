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
  BadRequestException,
} from '@nestjs/common';
import { InventoryMigrationService } from './inventory-migration.service';
import { SupplierService } from './supplier.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import {
  CutoverInput,
  CostApprovalRequest,
  MigrationResult,
  LocationPreview,
} from './types';
import {
  ExtractCostsRequest,
  ApproveBatchRequest,
  ApproveCostsRequest,
  InitiateCutoverRequest,
  PreviewCutoverRequest,
} from './inventory-migration.dto';

@Controller('admin/inventory/cutover')
export class InventoryMigrationController {
  constructor(
    private readonly migrationService: InventoryMigrationService,
    private readonly supplierService: SupplierService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Helper to normalize batch size from various inputs (string/number)
   */
  private parseBatchSize(input?: number | string | null): number | null {
    if (input === null || input === undefined) return null;
    if (typeof input === 'number') return input > 0 ? input : null;
    if (typeof input === 'string') {
      const parsed = parseInt(input.trim(), 10);
      return !isNaN(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  }

  /**
   * Helper to safely parse dates
   */
  private parseDate(dateStr?: string | null): Date | null {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date;
  }

  // --- SUPPLIER ENDPOINTS ---

  @Get('suppliers/suggest')
  async suggestSuppliers(
    @Query('q') searchTerm?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const suppliers = await this.supplierService.suggestSuppliers(
      searchTerm || '',
      limitNum,
    );
    return { success: true, suppliers };
  }

  @Get('suppliers')
  async getAllSuppliers() {
    // Optimization: Select only needed fields
    const suppliers = await this.prisma.supplier.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        initials: true,
        contactInfo: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      success: true,
      suppliers: suppliers.map((s) => ({
        ...s,
        initials: Array.isArray(s.initials) ? s.initials : (s.initials ? [s.initials] : []),
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      })),
    };
  }

  @Post('suppliers/:id/update')
  async updateSupplier(
    @Param('id') id: string,
    @Body() body: { name?: string; initials?: string[] | string | null; contactInfo?: string | null; isActive?: boolean },
  ) {
    const updateData: Prisma.SupplierUpdateInput = {};
    
    if (body.name !== undefined) updateData.name = body.name.trim();
    if (body.contactInfo !== undefined) updateData.contactInfo = body.contactInfo?.trim() || null;
    if (body.isActive !== undefined) updateData.isActive = body.isActive;

    // Robust initials handling
    if (body.initials !== undefined) {
      if (Array.isArray(body.initials)) {
        updateData.initials = body.initials
          .filter(i => i && typeof i === 'string' && i.trim().length > 0)
          .map(i => i.trim());
      } else if (typeof body.initials === 'string' && body.initials.trim()) {
        updateData.initials = [body.initials.trim()];
      } else {
        updateData.initials = [];
      }
    }

    try {
      const supplier = await this.prisma.supplier.update({
        where: { id },
        data: updateData,
      });

      return { success: true, supplier };
    } catch (error) {
      if ((error as any).code === 'P2025') {
        throw new HttpException({ success: false, message: 'Supplier not found' }, HttpStatus.NOT_FOUND);
      }
      throw new HttpException({ success: false, message: 'Update failed' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('suppliers/add-initial')
  async addInitialToSupplier(
    @Body() body: { supplierName: string; initial: string },
  ) {
    try {
      await this.supplierService.addInitialToSupplier(body.supplierName, body.initial);
      return { success: true, message: 'Initial added successfully' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to add initial: ${error}` },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('suppliers')
  async createSupplier(
    @Body() body: { name: string; initials?: string[] | string | null; contactInfo?: string | null },
  ) {
    try {
      // 1. Find or create basic supplier
      const supplier = await this.supplierService.findOrCreateSupplier(body.name);

      // 2. If we need to add extra details, update immediately
      const hasUpdates = body.initials || body.contactInfo;
      let finalSupplier = supplier;

      if (hasUpdates) {
        const updateData: Prisma.SupplierUpdateInput = {};
        
        if (body.contactInfo !== undefined) {
          updateData.contactInfo = body.contactInfo?.trim() || null;
        }

        if (body.initials !== undefined) {
          if (Array.isArray(body.initials)) {
            updateData.initials = body.initials
              .filter(i => i && typeof i === 'string' && i.trim().length > 0)
              .map(i => i.trim());
          } else if (typeof body.initials === 'string' && body.initials.trim()) {
            updateData.initials = [body.initials.trim()];
          }
        }
        
        // Only run update if we generated data to update
        if (Object.keys(updateData).length > 0) {
          finalSupplier = await this.prisma.supplier.update({
            where: { id: supplier.id },
            data: updateData,
          });
        }
      }

      return { success: true, supplier: finalSupplier };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to create supplier: ${error}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('suppliers/:id/delete')
  async deleteSupplier(@Param('id') id: string) {
    try {
      await this.prisma.supplier.update({
        where: { id },
        data: { isActive: false },
      });
      return { success: true, message: 'Supplier deactivated successfully' };
    } catch (e) {
       throw new HttpException({ success: false, message: 'Failed to deactivate supplier' }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('suppliers/:id/products')
  async getSupplierProducts(@Param('id') id: string) {
    try {
      const supplierProducts = await this.prisma.supplierProduct.findMany({
        where: { supplierId: id },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              squareProductName: true,
              squareVariationName: true,
            },
          },
        },
        orderBy: {
          product: {
            name: 'asc',
          },
        },
      });

      const products = supplierProducts.map((sp) => ({
        id: sp.id,
        productId: sp.productId,
        productName: sp.product.squareProductName || sp.product.squareVariationName || sp.product.name,
        name: sp.product.name,
        sku: sp.product.sku,
        cost: sp.cost.toString(),
        isPreferred: sp.isPreferred,
        notes: sp.notes,
        updatedAt: null, // SupplierProduct doesn't have updatedAt in schema
      }));

      return {
        success: true,
        products,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to fetch supplier products: ${error instanceof Error ? error.message : String(error)}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // --- CUTOVER / MIGRATION ENDPOINTS ---

  @Post('extract-costs')
  async extractCostsForApproval(@Body() body: ExtractCostsRequest & { newBatchSize?: number | string | null }) {
    if (body.costBasis !== 'DESCRIPTION') {
      throw new BadRequestException('Cost basis must be DESCRIPTION for cost extraction');
    }

    const batchSize = this.parseBatchSize(body.batchSize);
    const newBatchSize = this.parseBatchSize(body.newBatchSize);

    try {
      const result = await this.migrationService.extractCostsForMigration(
        body.locationIds,
        body.costBasis,
        batchSize,
        body.extractionSessionId || null,
        newBatchSize || null,
      );

      return {
        success: true,
        result,
        message: 'Cost extraction completed. Please review and approve.',
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Cost extraction failed: ${error}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('approve-batch')
  async approveBatch(@Body() body: ApproveBatchRequest) {
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

      const entriesToAddToHistory = body.entriesToAddToHistory?.map((entry) => ({
        productId: entry.productId,
        supplierName: entry.supplierName,
        supplierId: entry.supplierId || null,
        cost: entry.cost,
        effectiveAt: this.parseDate(entry.effectiveAt) || undefined,
      })) || null;

      const result = await this.migrationService.approveBatch(
        body.batchId,
        body.extractionApproved,
        body.manualInputApproved,
        approvedCosts,
        body.supplierInitialsUpdates || null,
        entriesToAddToHistory,
        null, // approvedBy placeholder
        null, // effectiveAt placeholder
      );

      return {
        success: true,
        batchId: body.batchId,
        nextBatchAvailable: result.nextBatchAvailable,
        lastApprovedProductId: result.lastApprovedProductId,
        message: 'Batch approved successfully',
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Batch approval failed: ${error}` },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('discard-item')
  async discardItem(@Body() body: { cutoverId: string; productId: string }) {
    try {
      const result = await this.migrationService.discardItem(body.cutoverId, body.productId);
      return result;
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to discard item: ${error}` },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('restore-item')
  async restoreItem(@Body() body: { cutoverId: string; productId: string }) {
    try {
      const result = await this.migrationService.restoreItem(body.cutoverId, body.productId);
      return result;
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to restore item: ${error}` },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('approve-item')
  async approveItem(
    @Body()
    body: {
      cutoverId: string;
      productId: string;
      cost: number;
      source?: string;
      notes?: string | null;
      extractedEntries?: Array<{
        supplier: string;
        amount: number;
        supplierId?: string | null;
        editedSupplierName?: string | null;
        editedCost?: number | null;
        editedEffectiveDate?: string | null;
        isSelected?: boolean;
      }>;
      selectedSupplierId?: string | null;
      selectedSupplierName?: string | null;
    },
  ) {
    try {
      const result = await this.migrationService.approveItem(
        body.cutoverId,
        body.productId,
        body.cost,
        body.source || 'DESCRIPTION',
        body.notes || null,
        body.extractedEntries || [],
        body.selectedSupplierId || null,
        body.selectedSupplierName || null,
      );
      return result;
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to approve item: ${error}` },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('update-batch-size')
  async updateBatchSize(@Body() body: { extractionSessionId: string; newBatchSize: number }) {
    try {
      if (!body.newBatchSize || body.newBatchSize < 10 || body.newBatchSize > 500) {
        throw new BadRequestException('Batch size must be between 10 and 500');
      }
      const result = await this.migrationService.updateBatchSize(body.extractionSessionId, body.newBatchSize);
      return result;
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to update batch size: ${error}` },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('extraction-session/:sessionId')
  async getExtractionSession(@Param('sessionId') sessionId: string) {
    try {
      const session = await this.migrationService.getExtractionSession(sessionId);
      
      if (!session) {
        throw new HttpException(
          { success: false, message: 'Extraction session not found' },
          HttpStatus.NOT_FOUND,
        );
      }

      // Safe access to properties with 'any' cast for complex nested structure
      const sessionData = session as any;

      return {
        success: true,
        session: {
          ...sessionData,
          createdAt: sessionData.createdAt.toISOString(),
          updatedAt: sessionData.updatedAt.toISOString(),
          batches: sessionData.batches?.map((b: any) => ({
            ...b,
            extractedAt: b.extractedAt?.toISOString(),
            approvedAt: b.approvedAt?.toISOString() || null,
            createdAt: b.createdAt.toISOString(),
            updatedAt: b.updatedAt.toISOString(),
          })) || [],
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to get extraction session: ${error}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('extraction-sessions')
  async listExtractionSessions(@Query('locationId') locationId?: string) {
    try {
      const sessions = await this.migrationService.listExtractionSessions(locationId);
      return {
        success: true,
        sessions: sessions.map(session => ({
          ...session,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
        })),
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to list extraction sessions: ${error}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('approve-costs')
  async approveExtractedCosts(@Body() body: ApproveCostsRequest) {
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

      const effectiveAt = this.parseDate(body.effectiveAt);

      const entriesToAddToHistory = body.entriesToAddToHistory?.map((entry) => ({
        productId: entry.productId,
        supplierName: entry.supplierName,
        supplierId: entry.supplierId || null,
        cost: entry.cost,
        effectiveAt: this.parseDate(entry.effectiveAt) || undefined,
      })) || null;

      await this.migrationService.storeCostApprovals(
        body.cutoverId,
        approvedCosts,
        null, // approvedBy
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
      throw new HttpException(
        { success: false, message: `Cost approval failed: ${error}` },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async cutover(@Body() body: InitiateCutoverRequest) {
    return this.initiateCutover(body);
  }

  @Post('initiate')
  async initiateCutover(@Body() body: InitiateCutoverRequest) {
    const cutoverDate = this.parseDate(body.cutoverDate);
    if (!cutoverDate) {
      throw new BadRequestException('Invalid cutover date format');
    }

    let approvedCosts: { productId: string; cost: Prisma.Decimal }[] = [];

    // 1. Resolve Costs
    if (body.costBasis === 'DESCRIPTION' && body.approvalId) {
      approvedCosts = await this.migrationService.getCostApprovals(body.approvalId);
    } else if (body.manualCosts) {
      approvedCosts = body.manualCosts.map((mc) => ({
        productId: mc.productId,
        cost: new Prisma.Decimal(mc.cost),
      }));
    }

    const input = {
      cutoverDate,
      locationIds: body.locationIds,
      costBasis: body.costBasis,
      ownerApproved: body.ownerApproved,
      ownerApprovedAt: new Date(),
      ownerApprovedBy: null,
      approvedCosts: approvedCosts.length > 0 ? approvedCosts : null,
    };

    const batchSize = this.parseBatchSize(body.batchSize);

    try {
      const result = await this.migrationService.executeInventoryMigration(
        input,
        approvedCosts,
        batchSize,
        body.cutoverId || null,
      );

      return {
        success: true,
        result,
        message: 'Inventory cutover initiated successfully',
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Cutover failed: ${error}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('continue')
  async continueCutover(@Body() body: { cutoverId: string }) {
    const cutoverRecord = await this.prisma.cutover.findUnique({
      where: { id: body.cutoverId },
    });

    if (!cutoverRecord) {
      throw new HttpException({ success: false, message: 'Cutover not found' }, HttpStatus.NOT_FOUND);
    }

    // Resolve approved costs (Prioritize JSON snapshot, fallback to DB table)
    let approvedCosts: { productId: string; cost: Prisma.Decimal }[] = [];
    const result = cutoverRecord.result as any;
    
    if (result?.approvedCosts) {
      approvedCosts = result.approvedCosts.map((ac: any) => ({
        productId: ac.productId,
        cost: new Prisma.Decimal(ac.cost),
      }));
    } else if (cutoverRecord.costBasis === 'DESCRIPTION') {
      approvedCosts = await this.migrationService.getCostApprovals(body.cutoverId);
    }

    try {
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
      throw new HttpException(
        { success: false, message: `Failed to continue migration: ${error}` },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('preview')
  async previewCutover(@Body() body: PreviewCutoverRequest) {
    const cutoverDate = this.parseDate(body.cutoverDate);
    if (!cutoverDate) throw new BadRequestException('Invalid cutover date');

    const approvedCosts = body.approvedCosts?.map((ac) => ({
      productId: ac.productId,
      cost: new Prisma.Decimal(ac.cost),
    }));

    try {
      const preview = await this.migrationService.previewCutover(
        {
          cutoverDate,
          locationIds: body.locationIds,
          costBasis: body.costBasis,
          ownerApproved: false,
          approvedCosts: approvedCosts || null,
        },
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
      throw new HttpException(
        { success: false, message: `Preview failed: ${error}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('status')
  async getCutoverStatus(@Query('locationId') locationId?: string) {
    const status = await this.migrationService.getCutoverStatus(locationId);
    return {
      ...status,
      cutoverDate: status.cutoverDate?.toISOString() || null,
      lockedAt: status.lockedAt?.toISOString() || null,
      locations: status.locations.map((loc) => ({
        ...loc,
        cutoverDate: loc.cutoverDate?.toISOString() || null,
      })),
    };
  }
}