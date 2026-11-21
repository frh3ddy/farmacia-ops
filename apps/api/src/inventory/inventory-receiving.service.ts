import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { listLimit } from './list-limit';
import { afterCursor, employeeNames, parseMovementCursor } from './movement-list';
import { Prisma } from '@prisma/client';
import { SquareClient } from 'square';
import { createSquareClient } from '../square/square-client';
import { findSquareVariationId, sendInventoryChanges } from './square-sync';
import { assertCutOver } from './cutover-gate';
import { assertSoldAtLocation } from './sold-at-location';

// ============================================================================
// Types
// ============================================================================

interface ReceiveInventoryInput {
  locationId: string;
  productId: string;
  quantity: number;
  unitCost: number;
  supplierId?: string;
  invoiceNumber?: string;
  purchaseOrderId?: string;
  batchNumber?: string;
  expiryDate?: Date;
  manufacturingDate?: Date;
  receivedBy?: string;
  notes?: string;
  syncToSquare?: boolean;
  clientRequestId?: string; // Dedup key for offline-queue replay (iOS)
}

interface ReceivingResult {
  receiving: {
    id: string;
    quantity: number;
    unitCost: string;
    totalCost: string;
    invoiceNumber: string | null;
    batchNumber: string | null;
    receivedAt: Date;
  };
  inventoryBatch: {
    id: string;
    quantity: number;
    unitCost: string;
    receivedAt: Date;
  };
  squareSync?: {
    synced: boolean;
    error?: string;
  };
  inventoryTotal: number;
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class InventoryReceivingService {
  private readonly logger = new Logger(InventoryReceivingService.name);
  private squareClient: SquareClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------------------
  // Square Client
  // --------------------------------------------------------------------------
  private getSquareClient(): SquareClient | null {
    return (this.squareClient ??= createSquareClient());
  }

  // --------------------------------------------------------------------------
  // Square Sync - RECEIVE_STOCK
  // --------------------------------------------------------------------------
  private async syncToSquare(
    receivingId: string,
    locationId: string,
    productId: string,
    quantity: number
  ): Promise<{ synced: boolean; error?: string }> {
    const client = this.getSquareClient();
    if (!client) {
      return { synced: false, error: 'Square client not configured' };
    }

    try {
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
        select: { squareId: true },
      });

      if (!location?.squareId) {
        return { synced: false, error: 'Location not linked to Square' };
      }

      const catalogObjectId = await findSquareVariationId(this.prisma, productId, locationId);
      if (!catalogObjectId) {
        return { synced: false, error: 'Product not mapped to Square catalog' };
      }

      this.logger.log(`[SQUARE_SYNC] Syncing receiving: catalogObjectId=${catalogObjectId}, locationId=${location.squareId}, quantity=${quantity}`);
      
      return await sendInventoryChanges(client, {
        // Keyed on the receiving record itself (not randomUUID()) so a retry
        // (retrySquareSync) replays the same key — Square returns the
        // original result instead of double-applying the stock change.
        idempotencyKey: receivingId,
        changes: [
          {
            type: 'ADJUSTMENT',
            adjustment: {
              catalogObjectId,
              fromLocationId: location.squareId,
              toLocationId: location.squareId,
              quantity: quantity.toString(),
              fromState: 'NONE',
              toState: 'IN_STOCK',
              occurredAt: new Date().toISOString(),
              referenceId: `receiving-${receivingId}`,
            },
          },
        ],
      }, this.logger, 'receiving');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SQUARE_SYNC] Failed to sync receiving to Square: ${errorMessage}`);
      return { synced: false, error: errorMessage };
    }
  }

  // --------------------------------------------------------------------------
  // Main receiving method
  // --------------------------------------------------------------------------
  async receiveInventory(input: ReceiveInventoryInput): Promise<ReceivingResult> {
    this.logger.log(
      `[RECEIVING] Receiving ${input.quantity} units of product ${input.productId} at location ${input.locationId}, cost: ${input.unitCost}`
    );

    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('La cantidad debe ser un número entero mayor que cero');
    }
    if (typeof input.unitCost !== 'number' || !Number.isFinite(input.unitCost) || input.unitCost < 0) {
      throw new BadRequestException('El costo unitario debe ser un número y no puede ser negativo');
    }

    // Idempotent replay: the offline-queue (iOS) may retry a write whose
    // original response was lost after it actually committed. Recognize the
    // client-supplied dedup key and return the existing result instead of
    // creating a duplicate batch.
    if (input.clientRequestId) {
      const existing = await this.findByClientRequestId(input);
      if (existing) {
        this.logger.log(`[RECEIVING] Duplicate clientRequestId ${input.clientRequestId} — returning existing receiving ${existing.receiving.id}`);
        return existing;
      }
    }

    try {
      return await this.recordReceiving(input);
    } catch (error) {
      // Two copies of the same replay raced past the lookup above; the loser's
      // insert hits the unique dedup key and its transaction rolled back.
      if (input.clientRequestId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.findByClientRequestId(input);
        if (existing) return existing;
      }
      throw error;
    }
  }

  private async recordReceiving(input: ReceiveInventoryInput): Promise<ReceivingResult> {
    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
    });
    if (!product) {
      throw new NotFoundException(`Product ${input.productId} not found`);
    }
    assertSoldAtLocation(product, input.locationId);

    const location = await this.prisma.location.findUnique({
      where: { id: input.locationId },
    });
    if (!location) {
      throw new NotFoundException(`Location ${input.locationId} not found`);
    }

    await assertCutOver(this.prisma, input.locationId);

    if (input.supplierId) {
      const supplier = await this.prisma.supplier.findUnique({
        where: { id: input.supplierId },
      });
      if (!supplier) {
        throw new NotFoundException(`Supplier ${input.supplierId} not found`);
      }
    }

    const totalCost = new Prisma.Decimal(input.unitCost).mul(input.quantity);

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create inventory batch
      const inventoryBatch = await tx.inventory.create({
        data: {
          locationId: input.locationId,
          productId: input.productId,
          quantity: input.quantity,
          receivedAt: new Date(),
          unitCost: new Prisma.Decimal(input.unitCost),
          source: 'PURCHASE',
          expiryDate: input.expiryDate,
          lotNumber: input.batchNumber,
        },
      });

      // 2. Create receiving record
      const receiving = await tx.inventoryReceiving.create({
        data: {
          locationId: input.locationId,
          productId: input.productId,
          supplierId: input.supplierId,
          quantity: input.quantity,
          unitCost: new Prisma.Decimal(input.unitCost),
          totalCost,
          invoiceNumber: input.invoiceNumber,
          purchaseOrderId: input.purchaseOrderId,
          batchNumber: input.batchNumber,
          expiryDate: input.expiryDate,
          manufacturingDate: input.manufacturingDate,
          inventoryBatchId: inventoryBatch.id,
          receivedBy: input.receivedBy,
          notes: input.notes,
          clientRequestId: input.clientRequestId,
        },
      });

      // 3. Update supplier product cost if supplier provided
      if (input.supplierId) {
        const existingPreferred = await tx.supplierProduct.findFirst({
          where: {
            productId: input.productId,
            isPreferred: true,
          },
          select: { supplierId: true },
        });

        const isNewPreferred = !existingPreferred || existingPreferred.supplierId !== input.supplierId;

        // If the receiving supplier is different from current preferred,
        // clear the old preferred flag so the new supplier becomes preferred
        if (isNewPreferred) {
          await tx.supplierProduct.updateMany({
            where: {
              productId: input.productId,
              isPreferred: true,
            },
            data: { isPreferred: false },
          });
        }

        await tx.supplierProduct.upsert({
          where: {
            supplierId_productId: {
              supplierId: input.supplierId,
              productId: input.productId,
            },
          },
          create: {
            supplierId: input.supplierId,
            productId: input.productId,
            cost: new Prisma.Decimal(input.unitCost),
            isPreferred: true,
            notes: `Auto-created from receiving ${receiving.id}`,
          },
          update: {
            cost: new Prisma.Decimal(input.unitCost),
            isPreferred: true,
          },
        });

        // 4. Add to supplier cost history
        const costHistoryEntry = await tx.supplierCostHistory.create({
          data: {
            productId: input.productId,
            supplierId: input.supplierId,
            unitCost: new Prisma.Decimal(input.unitCost),
            effectiveAt: new Date(),
            source: 'INVENTORY_UPDATE',
            isCurrent: true,
          },
        });

        // Mark previous history as not current
        await tx.supplierCostHistory.updateMany({
          where: {
            productId: input.productId,
            supplierId: input.supplierId,
            isCurrent: true,
            id: { not: costHistoryEntry.id }, // Exclude the one we just created
          },
          data: { isCurrent: false },
        });
      }

      return { receiving, inventoryBatch };
    });

    const inventoryTotal = await this.prisma.inventory.aggregate({
      where: {
        productId: input.productId,
        locationId: input.locationId,
        quantity: { gt: 0 },
      },
      _sum: { quantity: true },
    });

    this.logger.log(
      `[RECEIVING] Created receiving ${result.receiving.id} with batch ${result.inventoryBatch.id}`
    );

    const squareSync = input.syncToSquare ? await this.recordSquareSync(result.receiving) : undefined;

    return {
      receiving: {
        id: result.receiving.id,
        quantity: result.receiving.quantity,
        unitCost: result.receiving.unitCost.toString(),
        totalCost: result.receiving.totalCost.toString(),
        invoiceNumber: result.receiving.invoiceNumber,
        batchNumber: result.receiving.batchNumber,
        receivedAt: result.receiving.receivedAt,
      },
      inventoryBatch: {
        id: result.inventoryBatch.id,
        quantity: result.inventoryBatch.quantity,
        unitCost: result.inventoryBatch.unitCost.toString(),
        receivedAt: result.inventoryBatch.receivedAt,
      },
      squareSync,
      inventoryTotal: inventoryTotal._sum.quantity || 0,
    };
  }

  private async findByClientRequestId(input: ReceiveInventoryInput): Promise<ReceivingResult | null> {
    const existing = await this.prisma.inventoryReceiving.findUnique({
      where: { clientRequestId: input.clientRequestId },
      include: { inventoryBatch: true },
    });
    if (!existing) return null;
    // A replay repeats its request exactly. Anything else reusing the key is a
    // client bug — or a probe for another location's receiving.
    const sameRequest = existing.locationId === input.locationId
      && existing.productId === input.productId
      && existing.quantity === input.quantity
      && existing.unitCost.equals(input.unitCost);
    if (!sameRequest) {
      throw new ConflictException('This clientRequestId was already used for a different receiving');
    }

    const inventoryTotal = await this.prisma.inventory.aggregate({
      where: { productId: existing.productId, locationId: existing.locationId, quantity: { gt: 0 } },
      _sum: { quantity: true },
    });

    return {
      receiving: {
        id: existing.id,
        quantity: existing.quantity,
        unitCost: existing.unitCost.toString(),
        totalCost: existing.totalCost.toString(),
        invoiceNumber: existing.invoiceNumber,
        batchNumber: existing.batchNumber,
        receivedAt: existing.receivedAt,
      },
      inventoryBatch: {
        id: existing.inventoryBatch.id,
        quantity: existing.inventoryBatch.quantity,
        unitCost: existing.inventoryBatch.unitCost.toString(),
        receivedAt: existing.inventoryBatch.receivedAt,
      },
      squareSync: existing.squareSynced ? { synced: true } : undefined,
      inventoryTotal: inventoryTotal._sum.quantity || 0,
    };
  }

  // --------------------------------------------------------------------------
  // Query methods
  // --------------------------------------------------------------------------

  async getReceiving(receivingId: string) {
    const receiving = await this.prisma.inventoryReceiving.findUnique({
      where: { id: receivingId },
      include: {
        location: { select: { id: true, name: true } },
        product: { select: { id: true, name: true, sku: true } },
        supplier: { select: { id: true, name: true } },
        inventoryBatch: {
          select: { id: true, quantity: true, unitCost: true, receivedAt: true },
        },
      },
    });

    if (!receiving) {
      throw new NotFoundException(`Receiving ${receivingId} not found`);
    }

    return receiving;
  }

  async getReceivingsByLocation(locationId: string, options?: {
    startDate?: Date;
    endDate?: Date;
    supplierId?: string;
    productId?: string;
    limit?: number;
    cursor?: string;
  }) {
    const cursor = parseMovementCursor(options?.cursor);
    const rows = await this.prisma.inventoryReceiving.findMany({
      where: {
        locationId,
        ...afterCursor(cursor, 'receivedAt'),
        ...((options?.startDate || options?.endDate) && {
          receivedAt: {
            ...(options?.startDate && { gte: options.startDate }),
            ...(options?.endDate && { lte: options.endDate }),
          },
        }),
        ...(options?.supplierId && { supplierId: options.supplierId }),
        ...(options?.productId && { productId: options.productId }),
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        supplier: { select: { id: true, name: true } },
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: listLimit(options?.limit),
    });
    return this.withNames(rows);
  }

  private async withNames<T extends { receivedBy: string | null }>(rows: T[]) {
    const nameOf = await employeeNames(this.prisma, rows.map((r) => r.receivedBy));
    return rows.map((r) => ({ ...r, receivedByName: nameOf(r.receivedBy) }));
  }

  async getReceivingsByProduct(productId: string, locationId?: string) {
    const rows = await this.prisma.inventoryReceiving.findMany({
      where: {
        productId,
        ...(locationId && { locationId }),
      },
      include: {
        location: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: listLimit(undefined),
    });
    return this.withNames(rows);
  }

  async getReceivingSummary(locationId: string, startDate?: Date, endDate?: Date) {
    const where: Prisma.InventoryReceivingWhereInput = {
      locationId,
      ...((startDate || endDate) && {
        receivedAt: {
          ...(startDate && { gte: startDate }),
          ...(endDate && { lte: endDate }),
        },
      }),
    };

    const totals = await this.prisma.inventoryReceiving.aggregate({
      where,
      _count: { id: true },
      _sum: { quantity: true, totalCost: true },
    });

    const bySupplier = await this.prisma.inventoryReceiving.groupBy({
      by: ['supplierId'],
      where,
      _count: { id: true },
      _sum: { quantity: true, totalCost: true },
    });

    const supplierIds = bySupplier
      .filter(s => s.supplierId)
      .map(s => s.supplierId as string);
    
    const suppliers = await this.prisma.supplier.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true, name: true },
    });
    const supplierMap = new Map(suppliers.map(s => [s.id, s.name]));

    return {
      locationId,
      period: { startDate, endDate },
      totals: {
        receivingCount: totals._count.id,
        totalQuantity: totals._sum.quantity || 0,
        totalCost: totals._sum.totalCost?.toString() || '0',
      },
      bySupplier: bySupplier.map(s => ({
        supplierId: s.supplierId,
        supplierName: s.supplierId ? supplierMap.get(s.supplierId) || 'Unknown' : 'No Supplier',
        receivingCount: s._count.id,
        totalQuantity: s._sum.quantity || 0,
        totalCost: s._sum.totalCost?.toString() || '0',
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Correct a saved cost
  // --------------------------------------------------------------------------

  /**
   * Fixes a receiving saved with the wrong unit cost: the receiving, its batch
   * and the lot pieces split from it, what was already sold or lost from it
   * (consumptions, sale lines and totals, loss values), and the supplier's
   * current cost when this is its latest receiving of the product. Refused
   * once units were transferred, opened into loose units or sold and
   * returned: those carry the old cost into other batches.
   */
  async correctCost(receivingId: string, unitCost: number, correctedBy?: string): Promise<void> {
    if (typeof unitCost !== 'number' || !Number.isFinite(unitCost) || unitCost < 0) {
      throw new BadRequestException('El costo debe ser un número igual o mayor que 0');
    }
    const cost = new Prisma.Decimal(unitCost);

    await this.prisma.$transaction(async (tx) => {
      const receiving = await tx.inventoryReceiving.findUnique({ where: { id: receivingId } });
      if (!receiving) throw new NotFoundException(`Receiving ${receivingId} not found`);

      const pieces = await tx.inventory.findMany({ where: { splitFromId: receiving.inventoryBatchId }, select: { id: true } });
      const batchIds = [receiving.inventoryBatchId, ...pieces.map((p) => p.id)];
      // Hold the batches so a sale can't take units at the old cost mid-correction.
      await tx.$queryRaw`SELECT id FROM "Inventory" WHERE id IN (${Prisma.join(batchIds)}) FOR UPDATE`;

      const consumptions = await tx.inventoryConsumption.findMany({
        where: { inventoryId: { in: batchIds } },
        include: { adjustment: { select: { type: true } }, saleItem: { select: { saleId: true, _count: { select: { returns: true } } } } },
      });
      const transferred = await tx.transferLine.count({ where: { sourceInventoryId: { in: batchIds } } });
      if (transferred > 0 || consumptions.some((c) => c.adjustment?.type === 'BREAK_BULK_OUT' || (c.saleItem?._count.returns ?? 0) > 0)) {
        throw new ConflictException(
          'No se puede corregir el costo: parte de esta recepción ya se transfirió, se abrió en piezas o se devolvió. Pide la corrección a soporte.',
        );
      }

      await tx.inventoryReceiving.update({ where: { id: receivingId }, data: { unitCost: cost, totalCost: cost.mul(receiving.quantity) } });
      // The old cost lives nowhere else once this commits: keep it, and who changed it.
      await tx.auditLog.create({
        data: {
          employeeId: correctedBy,
          locationId: receiving.locationId,
          action: 'CORRECT_RECEIVING_COST',
          entityType: 'InventoryReceiving',
          entityId: receivingId,
          details: {
            oldUnitCost: receiving.unitCost.toString(),
            newUnitCost: cost.toString(),
            salesRecosted: new Set(consumptions.flatMap((c) => c.saleItem?.saleId ?? [])).size,
            adjustmentsRecosted: new Set(consumptions.flatMap((c) => c.adjustmentId ?? [])).size,
          },
        },
      });
      await tx.inventory.updateMany({ where: { id: { in: batchIds } }, data: { unitCost: cost } });

      for (const c of consumptions) {
        const totalCost = cost.mul(c.quantity);
        const delta = totalCost.sub(c.totalCost);
        await tx.inventoryConsumption.update({ where: { id: c.id }, data: { unitCost: cost, totalCost } });
        if (c.saleItemId && c.saleItem) {
          await tx.saleItem.update({ where: { id: c.saleItemId }, data: { cost: { increment: delta } } });
          await tx.sale.update({ where: { id: c.saleItem.saleId }, data: { totalCost: { increment: delta }, grossProfit: { decrement: delta } } });
        }
        if (c.adjustmentId) {
          const adjustment = await tx.inventoryAdjustment.update({ where: { id: c.adjustmentId }, data: { totalCost: { increment: delta } } });
          await tx.inventoryAdjustment.update({
            where: { id: c.adjustmentId },
            data: { unitCost: adjustment.totalCost.div(Math.abs(adjustment.quantity) || 1) },
          });
        }
      }

      if (!receiving.supplierId) return;
      const later = await tx.inventoryReceiving.count({
        where: { productId: receiving.productId, supplierId: receiving.supplierId, receivedAt: { gt: receiving.receivedAt } },
      });
      if (later > 0) return;
      const key = { supplierId: receiving.supplierId, productId: receiving.productId };
      await tx.supplierProduct.updateMany({ where: key, data: { cost } });
      await tx.supplierCostHistory.updateMany({ where: { ...key, isCurrent: true }, data: { isCurrent: false } });
      await tx.supplierCostHistory.create({ data: { ...key, unitCost: cost, effectiveAt: new Date(), source: 'MANUAL', isCurrent: true } });
    });
    this.logger.log(`[RECEIVING] Cost of receiving ${receivingId} corrected to ${unitCost}`);
  }

  // --------------------------------------------------------------------------
  // Retry Square sync
  // --------------------------------------------------------------------------

  /**
   * Resends a receipt whose Square sync failed. Only a recorded failure is
   * retried, as with transfers: one never sent (or sent before results were
   * recorded) may already be in Square.
   */
  async retrySquareSync(receivingId: string): Promise<{ synced: boolean; error?: string }> {
    const receiving = await this.prisma.inventoryReceiving.findUnique({
      where: { id: receivingId },
    });

    if (!receiving) {
      throw new NotFoundException(`Receiving ${receivingId} not found`);
    }

    if (receiving.squareSynced) {
      return { synced: true };
    }
    if (!receiving.squareSyncError) {
      throw new BadRequestException('Esta recepción no tiene un envío fallido a Square que reintentar');
    }
    return this.recordSquareSync(receiving);
  }

  /** Pushes a committed receiving to Square and records the outcome on it. */
  private async recordSquareSync(receiving: {
    id: string; locationId: string; productId: string; quantity: number;
  }): Promise<{ synced: boolean; error?: string }> {
    const result = await this.syncToSquare(receiving.id, receiving.locationId, receiving.productId, receiving.quantity);
    await this.prisma.inventoryReceiving.update({
      where: { id: receiving.id },
      data: {
        squareSynced: result.synced,
        squareSyncedAt: result.synced ? new Date() : null,
        squareSyncError: result.error || null,
      },
    });
    return result;
  }
}
