import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { SquareClient, SquareEnvironment } from 'square';
import { randomUUID } from 'crypto';

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
  // Square Sync - RECEIVE_STOCK
  // --------------------------------------------------------------------------
  private async syncToSquare(
    locationId: string,
    productId: string,
    quantity: number
  ): Promise<{ synced: boolean; error?: string }> {
    const client = this.getSquareClient();
    if (!client) {
      return { synced: false, error: 'Square client not configured' };
    }

    try {
      // Get Square location ID
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
        select: { squareId: true },
      });

      if (!location?.squareId) {
        return { synced: false, error: 'Location not linked to Square' };
      }

      // Get Square catalog variation ID
      const catalogMapping = await this.prisma.catalogMapping.findFirst({
        where: { productId },
        select: { squareVariationId: true },
      });

      if (!catalogMapping?.squareVariationId) {
        return { synced: false, error: 'Product not mapped to Square catalog' };
      }

      // Call Square Inventory API - RECEIVE_STOCK increases inventory
      // batchCreateChanges is the current method name in Square SDK
      this.logger.log(`[SQUARE_SYNC] Syncing receiving: catalogObjectId=${catalogMapping.squareVariationId}, locationId=${location.squareId}, quantity=${quantity}`);
      
      const response = await client.inventory.batchCreateChanges({
        idempotencyKey: randomUUID(),
        changes: [
          {
            type: 'ADJUSTMENT',
            adjustment: {
              catalogObjectId: catalogMapping.squareVariationId,
              locationId: location.squareId,
              quantity: quantity.toString(),
              fromState: 'NONE',
              toState: 'IN_STOCK',
              occurredAt: new Date().toISOString(),
              referenceId: `receiving-${Date.now()}`,
            },
          },
        ],
      });

      this.logger.log(`[SQUARE_SYNC] Successfully synced receiving to Square. Response counts: ${JSON.stringify(response.counts || 'no counts')}`);
      return { synced: true };

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

    // Validate input
    if (input.quantity <= 0) {
      throw new BadRequestException('Quantity must be positive');
    }
    if (input.unitCost < 0) {
      throw new BadRequestException('Unit cost cannot be negative');
    }

    // Check product exists
    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
    });
    if (!product) {
      throw new NotFoundException(`Product ${input.productId} not found`);
    }

    // Check location exists
    const location = await this.prisma.location.findUnique({
      where: { id: input.locationId },
    });
    if (!location) {
      throw new NotFoundException(`Location ${input.locationId} not found`);
    }

    // Check supplier if provided
    if (input.supplierId) {
      const supplier = await this.prisma.supplier.findUnique({
        where: { id: input.supplierId },
      });
      if (!supplier) {
        throw new NotFoundException(`Supplier ${input.supplierId} not found`);
      }
    }

    const totalCost = new Prisma.Decimal(input.unitCost).mul(input.quantity);

    // Execute in transaction
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
        },
      });

      // 3. Update supplier product cost if supplier provided
      if (input.supplierId) {
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
          },
        });

        // 4. Add to supplier cost history
        await tx.supplierCostHistory.create({
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
            id: { not: receiving.id }, // Exclude the one we just created
          },
          data: { isCurrent: false },
        });
      }

      return { receiving, inventoryBatch };
    });

    // Get updated inventory total
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

    // Optionally sync to Square
    let squareSync: { synced: boolean; error?: string } | undefined;
    if (input.syncToSquare) {
      squareSync = await this.syncToSquare(
        input.locationId,
        input.productId,
        input.quantity
      );

      // Update receiving record with sync status
      await this.prisma.inventoryReceiving.update({
        where: { id: result.receiving.id },
        data: {
          squareSynced: squareSync.synced,
          squareSyncedAt: squareSync.synced ? new Date() : null,
          squareSyncError: squareSync.error || null,
        },
      });
    }

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
  }) {
    return this.prisma.inventoryReceiving.findMany({
      where: {
        locationId,
        ...(options?.startDate && { receivedAt: { gte: options.startDate } }),
        ...(options?.endDate && { receivedAt: { lte: options.endDate } }),
        ...(options?.supplierId && { supplierId: options.supplierId }),
        ...(options?.productId && { productId: options.productId }),
      },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        supplier: { select: { id: true, name: true } },
      },
      orderBy: { receivedAt: 'desc' },
      take: options?.limit || 100,
    });
  }

  async getReceivingsByProduct(productId: string, locationId?: string) {
    return this.prisma.inventoryReceiving.findMany({
      where: {
        productId,
        ...(locationId && { locationId }),
      },
      include: {
        location: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
      orderBy: { receivedAt: 'desc' },
    });
  }

  async getReceivingSummary(locationId: string, startDate?: Date, endDate?: Date) {
    const where: Prisma.InventoryReceivingWhereInput = {
      locationId,
      ...(startDate && { receivedAt: { gte: startDate } }),
      ...(endDate && { receivedAt: { lte: endDate } }),
    };

    // Get totals
    const totals = await this.prisma.inventoryReceiving.aggregate({
      where,
      _count: { id: true },
      _sum: { quantity: true, totalCost: true },
    });

    // Get by supplier
    const bySupplier = await this.prisma.inventoryReceiving.groupBy({
      by: ['supplierId'],
      where,
      _count: { id: true },
      _sum: { quantity: true, totalCost: true },
    });

    // Get supplier names
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
  // Retry Square sync
  // --------------------------------------------------------------------------
  async retrySquareSync(receivingId: string): Promise<{ synced: boolean; error?: string }> {
    const receiving = await this.prisma.inventoryReceiving.findUnique({
      where: { id: receivingId },
    });

    if (!receiving) {
      throw new NotFoundException(`Receiving ${receivingId} not found`);
    }

    if (receiving.squareSynced) {
      return { synced: true, error: 'Already synced' };
    }

    const result = await this.syncToSquare(
      receiving.locationId,
      receiving.productId,
      receiving.quantity
    );

    await this.prisma.inventoryReceiving.update({
      where: { id: receivingId },
      data: {
        squareSynced: result.synced,
        squareSyncedAt: result.synced ? new Date() : null,
        squareSyncError: result.error || null,
      },
    });

    return result;
  }
}
