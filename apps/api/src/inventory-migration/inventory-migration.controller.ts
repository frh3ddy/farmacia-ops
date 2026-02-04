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

    const mappedSuppliers = suppliers.map((s) => ({
      ...s,
      initials: Array.isArray(s.initials) ? s.initials : (s.initials ? [s.initials] : []),
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));

    return {
      success: true,
      data: mappedSuppliers,  // iOS expects 'data'
      suppliers: mappedSuppliers,  // Keep for backward compatibility
      count: mappedSuppliers.length,
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

  @Get('suppliers/:id/products/:productId/cost-history')
  async getSupplierProductCostHistory(
    @Param('id') supplierId: string,
    @Param('productId') productId: string,
  ) {
    try {
      const costHistory = await this.prisma.supplierCostHistory.findMany({
        where: {
          supplierId,
          productId,
        },
        orderBy: {
          effectiveAt: 'desc',
        },
      });
      const history = costHistory.map((entry) => ({
        id: entry.id,
        cost: entry.unitCost.toString(),
        effectiveAt: entry.effectiveAt.toISOString(),
        createdAt: entry.createdAt.toISOString(),
        source: entry.source,
        isCurrent: entry.isCurrent,
      }));
      return {
        success: true,
        costHistory: history,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to fetch cost history: ${error instanceof Error ? error.message : String(error)}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('products/:productId/suppliers')
  async getProductSuppliers(@Param('productId') productId: string) {
    try {
      const supplierProducts = await this.prisma.supplierProduct.findMany({
        where: {
          productId,
        },
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              contactInfo: true,
              isActive: true,
            },
          },
        },
        orderBy: {
          supplier: {
            name: 'asc',
          },
        },
      });

      const suppliers = supplierProducts.map((sp) => ({
        id: sp.supplier.id,
        name: sp.supplier.name,
        contactInfo: sp.supplier.contactInfo,
        isActive: sp.supplier.isActive,
        cost: sp.cost.toString(),
        isPreferred: sp.isPreferred,
        notes: sp.notes,
      }));

      return {
        success: true,
        suppliers,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to fetch product suppliers: ${error instanceof Error ? error.message : String(error)}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('products/:productId/suppliers/cost-history')
  async getProductSuppliersCostHistory(@Param('productId') productId: string) {
    try {
      const costHistories = await this.prisma.supplierCostHistory.findMany({
        where: {
          productId,
        },
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: [
          {
            supplier: {
              name: 'asc',
            },
          },
          {
            effectiveAt: 'desc',
          },
        ],
      });

      // Group by supplier
      const groupedBySupplier = new Map<string, Array<{
        id: string;
        cost: string;
        effectiveAt: string;
        createdAt: string;
        source: string;
        isCurrent: boolean;
      }>>();

      for (const entry of costHistories) {
        const supplierId = entry.supplierId;
        if (!groupedBySupplier.has(supplierId)) {
          groupedBySupplier.set(supplierId, []);
        }
        groupedBySupplier.get(supplierId)!.push({
          id: entry.id,
          cost: entry.unitCost.toString(),
          effectiveAt: entry.effectiveAt.toISOString(),
          createdAt: entry.createdAt.toISOString(),
          source: entry.source,
          isCurrent: entry.isCurrent,
        });
      }

      // Convert to array format with supplier info
      const result = Array.from(groupedBySupplier.entries()).map(([supplierId, history]) => {
        const firstEntry = costHistories.find(e => e.supplierId === supplierId);
        return {
          supplierId,
          supplierName: firstEntry?.supplier.name || 'Unknown',
          costHistory: history,
        };
      });

      return {
        success: true,
        suppliers: result,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to fetch product suppliers cost history: ${error instanceof Error ? error.message : String(error)}` },
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

    // Validate location IDs upfront
    if (!body.locationIds || body.locationIds.length === 0) {
      throw new BadRequestException({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'At least one location must be specified',
          userMessage: 'Please select a location before starting extraction.',
          recoveryAction: 'Select a location from the dropdown and try again.',
          canRetry: true,
          canResume: false,
        },
      });
    }

    const batchSize = this.parseBatchSize(body.batchSize);
    const newBatchSize = this.parseBatchSize(body.newBatchSize);

    // Validate session if resuming
    if (body.extractionSessionId) {
      const validation = await this.migrationService.validateExtractionSession(body.extractionSessionId);
      if (!validation.valid) {
        throw new HttpException(
          {
            success: false,
            error: validation.error,
            message: validation.error?.userMessage || 'Invalid session',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    try {
      const result = await this.migrationService.extractCostsForMigration(
        body.locationIds,
        body.costBasis,
        batchSize,
        body.extractionSessionId || null,
        newBatchSize || null,
        body.cutoverDate || null,
      );

      // Serialize dates in the result's allApprovedItems
      const serializedResult = {
        ...result,
        allApprovedItems: result.allApprovedItems?.map(item => ({
          ...item,
          approvedAt: item.approvedAt?.toISOString() || null,
        })) || [],
        allSkippedItems: result.allSkippedItems || [],
      };

      return {
        success: true,
        result: serializedResult,
        message: 'Cost extraction completed. Please review and approve.',
      };
    } catch (error) {
      // Check if it's a structured ExtractionError
      if (error && typeof error === 'object' && 'code' in error) {
        const extractionError = error as any;
        throw new HttpException(
          {
            success: false,
            error: {
              code: extractionError.code,
              message: extractionError.message,
              userMessage: extractionError.userMessage,
              recoveryAction: extractionError.recoveryAction,
              canRetry: extractionError.canRetry,
              canResume: extractionError.canResume,
            },
            message: extractionError.userMessage || 'Cost extraction failed',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      
      // Generic error handling with helpful message
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'UNKNOWN_ERROR',
            message: errorMessage,
            userMessage: 'An unexpected error occurred during extraction.',
            recoveryAction: 'Try again. If the problem persists, contact support.',
            canRetry: true,
            canResume: !!body.extractionSessionId,
          },
          message: `Cost extraction failed: ${errorMessage}`,
        },
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
  async discardItem(
    @Body()
    body: {
      cutoverId: string;
      productId: string;
      sellingPrice?: { priceCents: number; currency: string } | null;
      sellingPriceRange?: { minCents: number; maxCents: number; currency: string } | null;
    },
  ) {
    try {
      const result = await this.migrationService.discardItem(
        body.cutoverId,
        body.productId,
        body.sellingPrice || null,
        body.sellingPriceRange || null,
      );
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
      sellingPrice?: { priceCents: number; currency: string } | null;
      sellingPriceRange?: { minCents: number; maxCents: number; currency: string } | null;
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
        body.sellingPrice || null,
        body.sellingPriceRange || null,
      );
      return result;
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to approve item: ${error}` },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('reuse-previous-approvals')
  async reusePreviousApprovals(
    @Body() body: { cutoverId: string; productIds?: string[] },
  ) {
    try {
      const result = await this.migrationService.reusePreviousApprovals(
        body.cutoverId,
        body.productIds || undefined,
      );
      return {
        success: true,
        approvedCount: result.approvedCount,
        products: result.products,
        message: `Successfully reused ${result.approvedCount} previous approval(s)`,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to reuse previous approvals: ${error}` },
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

  @Get('approvals-summary/:cutoverId')
  async getApprovalsSummary(
    @Param('cutoverId') cutoverId: string,
    @Query('includeAllSessions') includeAllSessions?: string,
  ) {
    try {
      // Default to including all sessions to show historical approvals
      const includeAll = includeAllSessions !== 'false';
      const summary = await this.migrationService.getApprovalsSummary(cutoverId, includeAll);
      
      return {
        success: true,
        ...summary,
        approvedItems: summary.approvedItems.map(item => ({
          ...item,
          approvedAt: item.approvedAt?.toISOString() || null,
        })),
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Failed to get approvals summary: ${error}` },
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
    if (!body.cutoverId || typeof body.cutoverId !== 'string' || body.cutoverId.trim() === '') {      throw new BadRequestException('cutoverId is required and must be a non-empty string');
    }
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

  // --- ERROR RECOVERY ENDPOINTS ---

  /**
   * Validate if an extraction session can be resumed
   */
  @Get('extraction-session/:sessionId/validate')
  async validateExtractionSession(@Param('sessionId') sessionId: string) {
    const result = await this.migrationService.validateExtractionSession(sessionId);
    
    if (!result.valid) {
      return {
        success: false,
        valid: false,
        error: result.error,
        message: result.error?.userMessage || 'Session validation failed',
      };
    }

    return {
      success: true,
      valid: true,
      session: result.session ? {
        id: result.session.id,
        status: result.session.status,
        currentBatch: result.session.currentBatch,
        totalBatches: result.session.totalBatches,
        processedItems: result.session.processedItems,
        totalItems: result.session.totalItems,
        updatedAt: result.session.updatedAt?.toISOString(),
      } : null,
    };
  }

  /**
   * Reset a failed extraction session to allow retry
   */
  @Post('extraction-session/:sessionId/reset')
  async resetExtractionSession(@Param('sessionId') sessionId: string) {
    const result = await this.migrationService.resetExtractionSession(sessionId);

    if (!result.success) {
      throw new HttpException(
        {
          success: false,
          error: result.error,
          message: result.error?.userMessage || 'Failed to reset session',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      success: true,
      message: 'Session reset successfully. You can now resume the extraction.',
      session: result.session ? {
        id: result.session.id,
        status: result.session.status,
        currentBatch: result.session.currentBatch,
      } : null,
    };
  }

  /**
   * Cleanup stale extraction sessions
   * Admin operation - cleans up sessions that have been IN_PROGRESS for too long
   */
  @Post('extraction-sessions/cleanup')
  async cleanupStaleSessions(@Body() body: { daysOld?: number }) {
    const daysOld = body.daysOld && body.daysOld > 0 ? body.daysOld : 7;

    try {
      const result = await this.migrationService.cleanupStaleSessions(daysOld);
      return {
        success: true,
        cleaned: result.cleaned,
        sessionIds: result.sessionIds,
        message: result.cleaned > 0 
          ? `Cleaned up ${result.cleaned} stale session(s)` 
          : 'No stale sessions found',
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Cleanup failed: ${error}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get detailed health/status information for extraction diagnostics
   */
  @Get('extraction-health')
  async getExtractionHealth(@Query('locationId') locationId?: string) {
    try {
      // Get active sessions count
      const activeSessions = await this.prisma.extractionSession.count({
        where: { status: 'IN_PROGRESS' },
      });

      // Get failed sessions (last 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      
      const failedSessions = await this.prisma.extractionSession.findMany({
        where: {
          status: 'FAILED',
          updatedAt: { gte: sevenDaysAgo },
        },
        select: {
          id: true,
          locationIds: true,
          currentBatch: true,
          totalBatches: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      });

      // Get pending approvals count
      const pendingApprovals = await this.prisma.costApproval.count({
        where: { migrationStatus: 'PENDING' },
      });

      // Get location-specific info if requested
      let locationHealth = null;
      if (locationId) {
        const location = await this.prisma.location.findUnique({
          where: { id: locationId },
          select: { id: true, name: true, squareId: true },
        });

        if (location) {
          const locationSessions = await this.prisma.extractionSession.count({
            where: {
              locationIds: { has: locationId },
              status: 'IN_PROGRESS',
            },
          });

          locationHealth = {
            locationId: location.id,
            locationName: location.name,
            hasSquareId: !!location.squareId,
            activeSessions: locationSessions,
          };
        }
      }

      return {
        success: true,
        health: {
          activeSessions,
          failedSessions: failedSessions.map(s => ({
            id: s.id,
            locationIds: s.locationIds,
            progress: `${s.currentBatch}/${s.totalBatches}`,
            failedAt: s.updatedAt?.toISOString(),
          })),
          pendingApprovals,
          locationHealth,
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: `Health check failed: ${error}` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}