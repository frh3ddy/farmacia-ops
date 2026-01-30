import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, AdjustmentType } from '@prisma/client';
import { SquareClient, SquareEnvironment } from 'square';
import { randomUUID } from 'crypto';

// ============================================================================
// Types
// ============================================================================

interface CreateAdjustmentInput {
  locationId: string;
  productId: string;
  type: AdjustmentType;
  quantity: number; // Positive = add, Negative = remove
  reason?: string;
  notes?: string;
  unitCost?: number; // Optional: will use FIFO cost for removals if not provided
  effectiveDate?: Date;
  adjustedBy?: string;
  syncToSquare?: boolean; // Whether to sync this adjustment to Square
}

interface AdjustmentResult {
  adjustment: {
    id: string;
    type: AdjustmentType;
    quantity: number;
    unitCost: string;
    totalCost: string;
    reason: string | null;
    notes: string | null;
    adjustedAt: Date;
    effectiveDate: Date;
  };
  inventoryImpact: {
    previousTotal: number;
    newTotal: number;
    batchesConsumed?: number; // For negative adjustments
    batchCreated?: string; // For positive adjustments
  };
  consumptions?: Array<{
    inventoryId: string;
    quantity: number;
    unitCost: string;
  }>;
  squareSync?: {
    synced: boolean;
    error?: string;
  };
}

interface ConsumedBatch {
  batchId: string;
  quantityConsumed: number;
  unitCost: Prisma.Decimal;
  costContribution: Prisma.Decimal;
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class InventoryAdjustmentService {
  private readonly logger = new Logger(InventoryAdjustmentService.name);
  private squareClient: SquareClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------------------
  // Square Client
  // --------------------------------------------------------------------------
  private getSquareClient(): SquareClient | null {
    if (!this.squareClient) {
      const token = process.env.SQUARE_ACCESS_TOKEN?.trim();
      if (!token) {
        this.logger.warn('SQUARE_ACCESS_TOKEN not set - Square sync disabled');
        return null;
      }

      const env = process.env.SQUARE_ENVIRONMENT?.toLowerCase();
      const nodeEnv = process.env.NODE_ENV?.toLowerCase();
      const isSandbox = env === 'sandbox' || nodeEnv === 'development';

      this.squareClient = new SquareClient({
        token,
        environment: isSandbox ? SquareEnvironment.Sandbox : SquareEnvironment.Production,
      });
    }
    return this.squareClient;
  }

  // --------------------------------------------------------------------------
  // Square Inventory Sync
  // --------------------------------------------------------------------------
  private async syncToSquare(
    locationId: string,
    productId: string,
    quantityChange: number,
    reason: string
  ): Promise<{ synced: boolean; error?: string }> {
    const client = this.getSquareClient();
    if (!client) {
      return { synced: false, error: 'Square client not configured' };
    }

    try {
      // Get the Square location ID
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
        select: { squareId: true },
      });

      if (!location?.squareId) {
        return { synced: false, error: 'Location not linked to Square' };
      }

      // Get the Square catalog object ID (variation ID) for this product
      const catalogMapping = await this.prisma.catalogMapping.findFirst({
        where: { productId },
        select: { squareVariationId: true },
      });

      if (!catalogMapping?.squareVariationId) {
        return { synced: false, error: 'Product not mapped to Square catalog' };
      }

      // Determine the adjustment type for Square
      // Square uses: PHYSICAL_COUNT, RECEIVE_STOCK, SALE, WASTE, SHRINKAGE, etc.
      const fromState = quantityChange > 0 ? 'NONE' : 'IN_STOCK';
      const toState = quantityChange > 0 ? 'IN_STOCK' : 'NONE';

      // Call Square Inventory API (batchCreateChanges is the current method name in Square SDK)
      const response = await client.inventory.batchCreateChanges({
        idempotencyKey: randomUUID(),
        changes: [
          {
            type: 'ADJUSTMENT',
            adjustment: {
              catalogObjectId: catalogMapping.squareVariationId,
              locationId: location.squareId,
              quantity: Math.abs(quantityChange).toString(),
              fromState,
              toState,
              occurredAt: new Date().toISOString(),
              referenceId: `adjustment-${Date.now()}`,
            },
          },
        ],
      });

      this.logger.log(`[SQUARE_SYNC] Successfully synced adjustment to Square`);
      return { synced: true };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SQUARE_SYNC] Failed to sync to Square: ${errorMessage}`);
      return { synced: false, error: errorMessage };
    }
  }

  // --------------------------------------------------------------------------
  // Main adjustment method
  // --------------------------------------------------------------------------
  async createAdjustment(input: CreateAdjustmentInput): Promise<AdjustmentResult> {
    this.logger.log(`[ADJUSTMENT] Creating ${input.type} adjustment for product ${input.productId} at location ${input.locationId}, qty: ${input.quantity}`);

    // Validate input
    if (input.quantity === 0) {
      throw new BadRequestException('Adjustment quantity cannot be zero');
    }

    // Check if product exists
    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
    });
    if (!product) {
      throw new NotFoundException(`Product ${input.productId} not found`);
    }

    // Check if location exists
    const location = await this.prisma.location.findUnique({
      where: { id: input.locationId },
    });
    if (!location) {
      throw new NotFoundException(`Location ${input.locationId} not found`);
    }

    // Check cutover lock
    const isLocked = await this.checkCutoverLock(input.locationId, input.effectiveDate || new Date());
    if (isLocked) {
      throw new BadRequestException(
        'Cannot make adjustments before the cutover date. The inventory for this location is locked.'
      );
    }

    // Get current inventory total
    const currentInventory = await this.prisma.inventory.aggregate({
      where: {
        productId: input.productId,
        locationId: input.locationId,
        quantity: { gt: 0 },
      },
      _sum: { quantity: true },
    });
    const previousTotal = currentInventory._sum.quantity || 0;

    // Route to appropriate handler
    if (input.quantity < 0) {
      return this.processNegativeAdjustment(input, previousTotal, product.name);
    } else {
      return this.processPositiveAdjustment(input, previousTotal, product.name);
    }
  }

  // --------------------------------------------------------------------------
  // Negative adjustment (consume inventory via FIFO)
  // --------------------------------------------------------------------------
  private async processNegativeAdjustment(
    input: CreateAdjustmentInput,
    previousTotal: number,
    productName: string
  ): Promise<AdjustmentResult> {
    const quantityToRemove = Math.abs(input.quantity);

    // Check if we have enough inventory
    if (quantityToRemove > previousTotal) {
      throw new BadRequestException(
        `Insufficient inventory: requested ${quantityToRemove}, available ${previousTotal}`
      );
    }

    // Get inventory batches (FIFO order - oldest first)
    const batches = await this.prisma.inventory.findMany({
      where: {
        productId: input.productId,
        locationId: input.locationId,
        quantity: { gt: 0 },
      },
      orderBy: { receivedAt: 'asc' },
    });

    // Calculate FIFO consumption
    const consumedBatches: ConsumedBatch[] = [];
    let remainingToConsume = quantityToRemove;
    let totalCost = new Prisma.Decimal(0);

    for (const batch of batches) {
      if (remainingToConsume <= 0) break;

      const quantityFromBatch = Math.min(batch.quantity, remainingToConsume);
      const costContribution = batch.unitCost.mul(quantityFromBatch);

      consumedBatches.push({
        batchId: batch.id,
        quantityConsumed: quantityFromBatch,
        unitCost: batch.unitCost,
        costContribution,
      });

      totalCost = totalCost.add(costContribution);
      remainingToConsume -= quantityFromBatch;
    }

    // Calculate weighted average unit cost
    const weightedUnitCost = totalCost.div(quantityToRemove);

    // Execute in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create the adjustment record
      const adjustment = await tx.inventoryAdjustment.create({
        data: {
          locationId: input.locationId,
          productId: input.productId,
          type: input.type,
          quantity: input.quantity, // Negative value
          reason: input.reason,
          notes: input.notes,
          unitCost: input.unitCost ? new Prisma.Decimal(input.unitCost) : weightedUnitCost,
          totalCost: totalCost,
          effectiveDate: input.effectiveDate || new Date(),
          adjustedBy: input.adjustedBy,
        },
      });

      // 2. Deduct from inventory batches
      for (const consumed of consumedBatches) {
        await tx.inventory.update({
          where: { id: consumed.batchId },
          data: {
            quantity: { decrement: consumed.quantityConsumed },
          },
        });
      }

      // 3. Create consumption records for audit trail
      await tx.inventoryConsumption.createMany({
        data: consumedBatches.map((c) => ({
          inventoryId: c.batchId,
          adjustmentId: adjustment.id,
          quantity: c.quantityConsumed,
          unitCost: c.unitCost,
          totalCost: c.costContribution,
        })),
      });

      return adjustment;
    });

    this.logger.log(
      `[ADJUSTMENT] Negative adjustment ${result.id}: removed ${quantityToRemove} units from ${consumedBatches.length} batches, total cost ${totalCost.toString()}`
    );

    // Optionally sync to Square
    let squareSync: { synced: boolean; error?: string } | undefined;
    if (input.syncToSquare) {
      squareSync = await this.syncToSquare(
        input.locationId,
        input.productId,
        input.quantity, // negative
        input.reason || input.type
      );
    }

    return {
      adjustment: {
        id: result.id,
        type: result.type,
        quantity: result.quantity,
        unitCost: result.unitCost.toString(),
        totalCost: result.totalCost.toString(),
        reason: result.reason,
        notes: result.notes,
        adjustedAt: result.adjustedAt,
        effectiveDate: result.effectiveDate,
      },
      inventoryImpact: {
        previousTotal,
        newTotal: previousTotal - quantityToRemove,
        batchesConsumed: consumedBatches.length,
      },
      consumptions: consumedBatches.map((c) => ({
        inventoryId: c.batchId,
        quantity: c.quantityConsumed,
        unitCost: c.unitCost.toString(),
      })),
      squareSync,
    };
  }

  // --------------------------------------------------------------------------
  // Positive adjustment (create new inventory batch)
  // --------------------------------------------------------------------------
  private async processPositiveAdjustment(
    input: CreateAdjustmentInput,
    previousTotal: number,
    productName: string
  ): Promise<AdjustmentResult> {
    // Unit cost is required for positive adjustments
    if (!input.unitCost && input.unitCost !== 0) {
      // Try to get the last known cost from supplier or previous inventory
      const lastCost = await this.getLastKnownCost(input.productId, input.locationId);
      if (!lastCost) {
        throw new BadRequestException(
          'Unit cost is required for positive adjustments. No previous cost history found.'
        );
      }
      input.unitCost = lastCost;
    }

    const totalCost = new Prisma.Decimal(input.unitCost).mul(input.quantity);

    // Execute in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create new inventory batch
      const inventoryBatch = await tx.inventory.create({
        data: {
          locationId: input.locationId,
          productId: input.productId,
          quantity: input.quantity,
          receivedAt: input.effectiveDate || new Date(),
          unitCost: new Prisma.Decimal(input.unitCost!),
          source: 'ADJUSTMENT',
        },
      });

      // 2. Create adjustment record (with reference to created batch)
      const adjustment = await tx.inventoryAdjustment.create({
        data: {
          locationId: input.locationId,
          productId: input.productId,
          type: input.type,
          quantity: input.quantity,
          reason: input.reason,
          notes: input.notes,
          unitCost: new Prisma.Decimal(input.unitCost!),
          totalCost: totalCost,
          createdBatchId: inventoryBatch.id,
          effectiveDate: input.effectiveDate || new Date(),
          adjustedBy: input.adjustedBy,
        },
      });

      return { adjustment, inventoryBatch };
    });

    this.logger.log(
      `[ADJUSTMENT] Positive adjustment ${result.adjustment.id}: added ${input.quantity} units as batch ${result.inventoryBatch.id}, cost ${totalCost.toString()}`
    );

    // Optionally sync to Square
    let squareSync: { synced: boolean; error?: string } | undefined;
    if (input.syncToSquare) {
      squareSync = await this.syncToSquare(
        input.locationId,
        input.productId,
        input.quantity, // positive
        input.reason || input.type
      );
    }

    return {
      adjustment: {
        id: result.adjustment.id,
        type: result.adjustment.type,
        quantity: result.adjustment.quantity,
        unitCost: result.adjustment.unitCost.toString(),
        totalCost: result.adjustment.totalCost.toString(),
        reason: result.adjustment.reason,
        notes: result.adjustment.notes,
        adjustedAt: result.adjustment.adjustedAt,
        effectiveDate: result.adjustment.effectiveDate,
      },
      inventoryImpact: {
        previousTotal,
        newTotal: previousTotal + input.quantity,
        batchCreated: result.inventoryBatch.id,
      },
      squareSync,
    };
  }

  // --------------------------------------------------------------------------
  // Helper methods
  // --------------------------------------------------------------------------

  private async checkCutoverLock(locationId: string, effectiveDate: Date): Promise<boolean> {
    const lock = await this.prisma.cutoverLock.findFirst({
      where: {
        OR: [
          { locationId }, // Specific location lock
          { locationId: null }, // Global lock
        ],
        cutoverDate: { gte: effectiveDate },
        isLocked: true,
      },
    });
    return !!lock;
  }

  private async getLastKnownCost(productId: string, locationId: string): Promise<number | null> {
    // Try supplier product cost first
    const supplierProduct = await this.prisma.supplierProduct.findFirst({
      where: { productId, isPreferred: true },
      orderBy: { cost: 'desc' },
    });
    if (supplierProduct) {
      return Number(supplierProduct.cost);
    }

    // Try last inventory batch at this location
    const lastBatch = await this.prisma.inventory.findFirst({
      where: { productId, locationId },
      orderBy: { receivedAt: 'desc' },
    });
    if (lastBatch) {
      return Number(lastBatch.unitCost);
    }

    // Try cost approval
    const approval = await this.prisma.costApproval.findFirst({
      where: { productId, migrationStatus: 'APPROVED' },
      orderBy: { approvedAt: 'desc' },
    });
    if (approval) {
      return Number(approval.approvedCost);
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Query methods
  // --------------------------------------------------------------------------

  async getAdjustment(adjustmentId: string) {
    const adjustment = await this.prisma.inventoryAdjustment.findUnique({
      where: { id: adjustmentId },
      include: {
        location: { select: { id: true, name: true } },
        product: { select: { id: true, name: true, sku: true } },
        consumptions: {
          select: {
            inventoryId: true,
            quantity: true,
            unitCost: true,
            totalCost: true,
            consumedAt: true,
          },
        },
        createdBatch: {
          select: { id: true, quantity: true, unitCost: true, receivedAt: true },
        },
      },
    });

    if (!adjustment) {
      throw new NotFoundException(`Adjustment ${adjustmentId} not found`);
    }

    return adjustment;
  }

  async getAdjustmentsByProduct(productId: string, locationId?: string) {
    return this.prisma.inventoryAdjustment.findMany({
      where: {
        productId,
        ...(locationId && { locationId }),
      },
      include: {
        location: { select: { id: true, name: true } },
        consumptions: {
          select: { inventoryId: true, quantity: true, unitCost: true },
        },
      },
      orderBy: { adjustedAt: 'desc' },
    });
  }

  async getAdjustmentsByLocation(locationId: string, options?: {
    startDate?: Date;
    endDate?: Date;
    type?: AdjustmentType;
    limit?: number;
  }) {
    return this.prisma.inventoryAdjustment.findMany({
      where: {
        locationId,
        ...(options?.startDate && { adjustedAt: { gte: options.startDate } }),
        ...(options?.endDate && { adjustedAt: { lte: options.endDate } }),
        ...(options?.type && { type: options.type }),
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        consumptions: {
          select: { quantity: true, unitCost: true },
        },
      },
      orderBy: { adjustedAt: 'desc' },
      take: options?.limit || 100,
    });
  }

  async getAdjustmentSummary(locationId: string, startDate?: Date, endDate?: Date) {
    const where: Prisma.InventoryAdjustmentWhereInput = {
      locationId,
      ...(startDate && { adjustedAt: { gte: startDate } }),
      ...(endDate && { adjustedAt: { lte: endDate } }),
    };

    // Get counts by type
    const byType = await this.prisma.inventoryAdjustment.groupBy({
      by: ['type'],
      where,
      _count: { id: true },
      _sum: { quantity: true, totalCost: true },
    });

    // Get totals
    const totals = await this.prisma.inventoryAdjustment.aggregate({
      where,
      _count: { id: true },
      _sum: { totalCost: true },
    });

    // Separate positive and negative
    const positiveTypes: AdjustmentType[] = ['FOUND', 'RETURN', 'TRANSFER_IN', 'COUNT_CORRECTION'];
    
    const positive = byType
      .filter(t => positiveTypes.includes(t.type) || (t._sum.quantity || 0) > 0)
      .reduce((acc, t) => ({
        count: acc.count + t._count.id,
        totalQuantity: acc.totalQuantity + Math.abs(t._sum.quantity || 0),
        totalCost: new Prisma.Decimal(acc.totalCost).add(t._sum.totalCost || 0).toString(),
      }), { count: 0, totalQuantity: 0, totalCost: '0' });

    const negative = byType
      .filter(t => !positiveTypes.includes(t.type) && (t._sum.quantity || 0) <= 0)
      .reduce((acc, t) => ({
        count: acc.count + t._count.id,
        totalQuantity: acc.totalQuantity + Math.abs(t._sum.quantity || 0),
        totalCost: new Prisma.Decimal(acc.totalCost).add(t._sum.totalCost || 0).toString(),
      }), { count: 0, totalQuantity: 0, totalCost: '0' });

    return {
      locationId,
      period: { startDate, endDate },
      totals: {
        adjustmentCount: totals._count.id,
        totalCostImpact: totals._sum.totalCost?.toString() || '0',
      },
      positive,
      negative,
      byType: byType.map(t => ({
        type: t.type,
        count: t._count.id,
        totalQuantity: t._sum.quantity || 0,
        totalCost: t._sum.totalCost?.toString() || '0',
      })),
    };
  }
}
