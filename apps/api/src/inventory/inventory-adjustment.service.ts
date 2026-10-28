import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, AdjustmentType } from '@prisma/client';
import { SquareClient, SquareEnvironment } from 'square';

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
  unitCost?: number; // Additions only (falls back to the last known cost); removals always use FIFO
  effectiveDate?: Date;
  adjustedBy?: string;
  syncToSquare?: boolean; // Whether to sync this adjustment to Square
  clientRequestId?: string; // Dedup key for offline-queue replay (iOS)
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
        version: '2026-09-16', // pinned so an SDK bump can't silently change behavior
      });
    }
    return this.squareClient;
  }

  // --------------------------------------------------------------------------
  // Square Inventory Sync
  // --------------------------------------------------------------------------
  private async syncToSquare(
    adjustmentId: string,
    locationId: string,
    productId: string,
    quantityChange: number,
    adjustmentType: string
  ): Promise<{ synced: boolean; error?: string }> {
    // A transfer's legs aren't pushed one by one: receiving the transfer sends
    // Square a single cross-location move (TransferService.syncReceiveToSquare),
    // so the shipment never shows up as waste. No error, so nothing offers a retry.
    if (adjustmentType === 'TRANSFER_OUT' || adjustmentType === 'TRANSFER_IN') {
      return { synced: false };
    }

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

      // Square's state transitions (Inventory API "Supported state transitions"):
      // - UNLINKED_RETURN → IN_STOCK: a customer return
      // - NONE → IN_STOCK: any other stock added (found, loose units, count up)
      // - IN_STOCK → NONE: boxes broken into loose units — removed from
      //   tracking, not lost, so they stay out of Square's waste reports
      // - IN_STOCK → WASTE: damage, theft, expired, write-off, count down
      let fromState: 'NONE' | 'IN_STOCK' | 'UNLINKED_RETURN';
      let toState: 'IN_STOCK' | 'WASTE' | 'NONE';
      if (quantityChange > 0) {
        fromState = adjustmentType === 'RETURN' ? 'UNLINKED_RETURN' : 'NONE';
        toState = 'IN_STOCK';
      } else {
        fromState = 'IN_STOCK';
        toState = adjustmentType === 'BREAK_BULK_OUT' ? 'NONE' : 'WASTE';
      }

      // Call Square Inventory API
      this.logger.log(`[SQUARE_SYNC] Syncing adjustment: catalogObjectId=${catalogMapping.squareVariationId}, locationId=${location.squareId}, quantity=${Math.abs(quantityChange)}, ${fromState} → ${toState}, type=${adjustmentType}`);
      
      const response = await client.inventory.batchCreateChanges({
        // Keyed on the adjustment record itself (not randomUUID()) so a
        // retry (retrySquareSync) replays the same key — Square returns the
        // original result instead of double-applying the stock change.
        idempotencyKey: adjustmentId,
        changes: [
          {
            type: 'ADJUSTMENT',
            adjustment: {
              catalogObjectId: catalogMapping.squareVariationId,
              // Same location on both sides: it changes state, not place.
              fromLocationId: location.squareId,
              toLocationId: location.squareId,
              quantity: Math.abs(quantityChange).toString(),
              fromState,
              toState,
              occurredAt: new Date().toISOString(),
              referenceId: `adjustment-${adjustmentType}-${adjustmentId}`,
            },
          },
        ],
      });

      if (response.errors && response.errors.length > 0) {
        const errorMessage = response.errors.map(e => e.detail || e.code).join('; ');
        this.logger.error(`[SQUARE_SYNC] Square rejected adjustment: ${errorMessage}`);
        return { synced: false, error: errorMessage };
      }

      this.logger.log(`[SQUARE_SYNC] Successfully synced adjustment to Square. Response counts: ${JSON.stringify(response.counts || 'no counts')}`);
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

    // Idempotent replay: the offline-queue (iOS) may retry a write whose
    // original response was lost after it actually committed. Recognize the
    // client-supplied dedup key and return the existing result instead of
    // applying the delta twice.
    if (input.clientRequestId) {
      const existing = await this.findByClientRequestId(input);
      if (existing) {
        this.logger.log(`[ADJUSTMENT] Duplicate clientRequestId ${input.clientRequestId} — returning existing adjustment ${existing.adjustment.id}`);
        return existing;
      }
    }

    // Validate input — the controller's DTO is a plain interface, so nothing
    // has checked the runtime types of what the client sent.
    if (!Number.isInteger(input.quantity) || input.quantity === 0) {
      throw new BadRequestException('Quantity must be a non-zero whole number');
    }
    if (input.unitCost != null && !(typeof input.unitCost === 'number' && input.unitCost >= 0)) {
      throw new BadRequestException('Unit cost must be zero or more');
    }
    if (input.type === 'OTHER' && !input.notes?.trim()) {
      throw new BadRequestException('Notes are required for an OTHER adjustment');
    }
    if ((input.reason?.length ?? 0) > 500 || (input.notes?.length ?? 0) > 500) {
      throw new BadRequestException('Reason and notes must be 500 characters or fewer');
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

    // A positive adjustment's batch is received at effectiveDate, so a future
    // date would park it at the back of the FIFO line. Past dates are fine.
    // End of today (server-local, like parseDateString) so a date-only "today",
    // parsed as noon, still passes in the morning.
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    if (input.effectiveDate && input.effectiveDate > endOfToday) {
      throw new BadRequestException('Adjustment effectiveDate cannot be in the future');
    }

    // Finishing a location's cutover writes its lock. Before that, the cutover
    // will set the location's opening stock from Square's counts, which would
    // count an adjustment's stock change a second time (or drop it).
    const lock = await this.prisma.cutoverLock.findFirst({
      where: { OR: [{ locationId: input.locationId }, { locationId: null }], isLocked: true },
      orderBy: { cutoverDate: 'desc' },
    });
    if (!lock) {
      throw new BadRequestException(
        'This location has not been cut over yet. Adjustments start once its cutover is complete.'
      );
    }
    if ((input.effectiveDate || new Date()) <= lock.cutoverDate) {
      throw new BadRequestException(
        'Cannot make adjustments before the cutover date. The inventory for this location is locked.'
      );
    }

    try {
      if (input.quantity < 0) {
        return await this.processNegativeAdjustment(input);
      }

      const currentInventory = await this.prisma.inventory.aggregate({
        where: {
          productId: input.productId,
          locationId: input.locationId,
          quantity: { gt: 0 },
        },
        _sum: { quantity: true },
      });
      return await this.processPositiveAdjustment(input, currentInventory._sum.quantity || 0);
    } catch (error) {
      // Two copies of the same replay raced past the lookup above; the loser's
      // insert hits the unique dedup key and its transaction rolled back.
      // (meta.target's shape varies with the driver adapter, so look the key up instead.)
      if (input.clientRequestId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.findByClientRequestId(input);
        if (existing) return existing;
      }
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Negative adjustment (consume inventory via FIFO)
  // --------------------------------------------------------------------------
  private async processNegativeAdjustment(input: CreateAdjustmentInput): Promise<AdjustmentResult> {
    const quantityToRemove = Math.abs(input.quantity);
    const consumedBatches: ConsumedBatch[] = [];
    let totalCost = new Prisma.Decimal(0);
    let previousTotal = 0;

    // Batches are read and decremented in the same transaction, and each
    // decrement only applies if the batch still holds that much — a sale or
    // another adjustment taking the same stock in between rolls this back
    // instead of driving the batch negative.
    const result = await this.prisma.$transaction(async (tx) => {
      // Get inventory batches (FIFO order - oldest first)
      const batches = await tx.inventory.findMany({
        where: {
          productId: input.productId,
          locationId: input.locationId,
          quantity: { gt: 0 },
        },
        orderBy: { receivedAt: 'asc' },
      });

      previousTotal = batches.reduce((sum, b) => sum + b.quantity, 0);
      if (quantityToRemove > previousTotal) {
        throw new BadRequestException(
          `Insufficient inventory: requested ${quantityToRemove}, available ${previousTotal}`
        );
      }

      // Calculate FIFO consumption
      let remainingToConsume = quantityToRemove;
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

      // 1. Create the adjustment record
      const adjustment = await tx.inventoryAdjustment.create({
        data: {
          locationId: input.locationId,
          productId: input.productId,
          type: input.type,
          quantity: input.quantity, // Negative value
          reason: input.reason,
          notes: input.notes,
          // Always FIFO: a client-supplied cost would disagree with totalCost.
          unitCost: weightedUnitCost,
          totalCost: totalCost,
          effectiveDate: input.effectiveDate || new Date(),
          adjustedBy: input.adjustedBy,
          clientRequestId: input.clientRequestId,
        },
      });

      // 2. Deduct from inventory batches
      for (const consumed of consumedBatches) {
        const { count } = await tx.inventory.updateMany({
          where: { id: consumed.batchId, quantity: { gte: consumed.quantityConsumed } },
          data: {
            quantity: { decrement: consumed.quantityConsumed },
          },
        });
        if (count === 0) {
          throw new ConflictException('Stock changed while recording this adjustment — please retry');
        }
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

    const squareSync = input.syncToSquare ? await this.recordSquareSync(result) : undefined;

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
    previousTotal: number
  ): Promise<AdjustmentResult> {
    // Unit cost is required for positive adjustments; fall back to the last known
    // cost (a looked-up 0 is no cost — only the caller can say an item is free)
    const unitCostValue = input.unitCost ?? ((await this.getLastKnownCost(input.productId, input.locationId)) || null);
    if (unitCostValue == null) {
      throw new BadRequestException(
        'Unit cost is required for positive adjustments. No previous cost history found.'
      );
    }
    const unitCost = new Prisma.Decimal(unitCostValue);
    const totalCost = unitCost.mul(input.quantity);

    // Execute in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create new inventory batch
      const inventoryBatch = await tx.inventory.create({
        data: {
          locationId: input.locationId,
          productId: input.productId,
          quantity: input.quantity,
          receivedAt: input.effectiveDate || new Date(),
          unitCost,
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
          unitCost,
          totalCost: totalCost,
          createdBatchId: inventoryBatch.id,
          effectiveDate: input.effectiveDate || new Date(),
          adjustedBy: input.adjustedBy,
          clientRequestId: input.clientRequestId,
        },
      });

      return { adjustment, inventoryBatch };
    });

    this.logger.log(
      `[ADJUSTMENT] Positive adjustment ${result.adjustment.id}: added ${input.quantity} units as batch ${result.inventoryBatch.id}, cost ${totalCost.toString()}`
    );

    const squareSync = input.syncToSquare ? await this.recordSquareSync(result.adjustment) : undefined;

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
  // Retry Square sync
  // --------------------------------------------------------------------------
  async retrySquareSync(adjustmentId: string): Promise<{ synced: boolean; error?: string }> {
    const adjustment = await this.prisma.inventoryAdjustment.findUnique({
      where: { id: adjustmentId },
    });

    if (!adjustment) {
      throw new NotFoundException(`Adjustment ${adjustmentId} not found`);
    }

    if (adjustment.squareSynced) {
      return { synced: true };
    }
    return this.recordSquareSync(adjustment);
  }

  /** Pushes a committed adjustment to Square and records the outcome on it. */
  private async recordSquareSync(adjustment: {
    id: string; locationId: string; productId: string; quantity: number; type: AdjustmentType;
  }): Promise<{ synced: boolean; error?: string }> {
    const result = await this.syncToSquare(
      adjustment.id,
      adjustment.locationId,
      adjustment.productId,
      adjustment.quantity,
      adjustment.type
    );
    await this.prisma.inventoryAdjustment.update({
      where: { id: adjustment.id },
      data: {
        squareSynced: result.synced,
        squareSyncedAt: result.synced ? new Date() : null,
        squareSyncError: result.error || null,
      },
    });
    return result;
  }

  // --------------------------------------------------------------------------
  // Helper methods
  // --------------------------------------------------------------------------

  private async findByClientRequestId(input: CreateAdjustmentInput): Promise<AdjustmentResult | null> {
    const existing = await this.prisma.inventoryAdjustment.findUnique({
      where: { clientRequestId: input.clientRequestId },
      include: { createdBatch: true, consumptions: true },
    });
    if (!existing) return null;
    // A replay repeats its request exactly. Anything else reusing the key is a
    // client bug — or a probe for another location's adjustment.
    const sameRequest = existing.locationId === input.locationId
      && existing.productId === input.productId
      && existing.type === input.type
      && existing.quantity === input.quantity;
    if (!sameRequest) {
      throw new ConflictException('This clientRequestId was already used for a different adjustment');
    }

    const currentTotal = await this.prisma.inventory.aggregate({
      where: { productId: existing.productId, locationId: existing.locationId, quantity: { gt: 0 } },
      _sum: { quantity: true },
    });
    const newTotal = currentTotal._sum.quantity || 0;

    return {
      adjustment: {
        id: existing.id,
        type: existing.type,
        quantity: existing.quantity,
        unitCost: existing.unitCost.toString(),
        totalCost: existing.totalCost.toString(),
        reason: existing.reason,
        notes: existing.notes,
        adjustedAt: existing.adjustedAt,
        effectiveDate: existing.effectiveDate,
      },
      inventoryImpact: {
        previousTotal: newTotal - existing.quantity,
        newTotal,
        batchesConsumed: existing.consumptions.length || undefined,
        batchCreated: existing.createdBatch?.id,
      },
      consumptions: existing.consumptions.length
        ? existing.consumptions.map((c) => ({
            inventoryId: c.inventoryId,
            quantity: c.quantity,
            unitCost: c.unitCost.toString(),
          }))
        : undefined,
    };
  }

  private async getLastKnownCost(productId: string, locationId: string): Promise<number | null> {
    // What this location last actually paid comes first; zero-cost batches
    // (test or uncosted stock) would make the added stock free.
    const lastBatch = await this.prisma.inventory.findFirst({
      where: { productId, locationId, unitCost: { gt: 0 } },
      orderBy: { receivedAt: 'desc' },
    });
    if (lastBatch) {
      return Number(lastBatch.unitCost);
    }

    // Then the preferred supplier's list cost
    const supplierProduct = await this.prisma.supplierProduct.findFirst({
      where: { productId, isPreferred: true },
      orderBy: { cost: 'desc' },
    });
    if (supplierProduct) {
      return Number(supplierProduct.cost);
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
        ...((options?.startDate || options?.endDate) && {
          adjustedAt: {
            ...(options?.startDate && { gte: options.startDate }),
            ...(options?.endDate && { lte: options.endDate }),
          },
        }),
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
}
