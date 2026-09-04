import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { buildTransferLines, resolveQuantityReceived } from './transfer';
import { SquareClient, SquareEnvironment } from 'square';

export interface ShipTransferInput {
  productId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  reason?: string;
  notes?: string;
  syncToSquare?: boolean;
  createdBy?: string;
}

export interface ReceiveTransferInput {
  transferId: string;
  lineReceipts?: { transferLineId: string; quantityReceived: number }[];
  syncToSquare?: boolean;
  receivedBy?: string;
}

/**
 * Location-aware transfers: move stock between locations for the SAME
 * product, never touching Sale/SaleItem (zero COGS/margin impact by
 * construction). Ship reuses InventoryAdjustmentService.createAdjustment's
 * existing FIFO consumption (TRANSFER_OUT); receive can't reuse its positive
 * path since a shipment spanning multiple lots must become multiple
 * destination lots (one per lot, each keeping its own cost + original
 * receivedAt) — createAdjustment's positive path only ever creates one.
 */
@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);
  private squareClient: SquareClient | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adjustments: InventoryAdjustmentService,
  ) {}

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
        version: '2025-01-23', // pinned so an SDK bump can't silently change behavior
      });
    }
    return this.squareClient;
  }

  /** Push a plain NONE->IN_STOCK ADJUSTMENT for the received quantity at toLocationId. */
  private async syncReceiveToSquare(
    transferId: string,
    locationId: string,
    productId: string,
    quantity: number,
  ): Promise<{ synced: boolean; error?: string }> {
    const client = this.getSquareClient();
    if (!client) return { synced: false, error: 'Square client not configured' };

    try {
      const location = await this.prisma.location.findUnique({ where: { id: locationId }, select: { squareId: true } });
      if (!location?.squareId) return { synced: false, error: 'Location not linked to Square' };

      const catalogMapping = await this.prisma.catalogMapping.findFirst({
        where: { productId },
        select: { squareVariationId: true },
      });
      if (!catalogMapping?.squareVariationId) return { synced: false, error: 'Product not mapped to Square catalog' };

      const response = await client.inventory.batchCreateChanges({
        // Keyed on the transfer itself (not randomUUID()) so a retry of this
        // receive call replays the same key — Square returns the original
        // result instead of double-applying the stock change.
        idempotencyKey: transferId,
        changes: [
          {
            type: 'ADJUSTMENT',
            adjustment: {
              catalogObjectId: catalogMapping.squareVariationId,
              locationId: location.squareId,
              quantity: quantity.toString(),
              fromState: 'NONE' as any,
              toState: 'IN_STOCK' as any,
              occurredAt: new Date().toISOString(),
              referenceId: `transfer-receive-${transferId}`,
            },
          },
        ],
      });

      if (response.errors && response.errors.length > 0) {
        const errorMessage = response.errors.map(e => e.detail || e.code).join('; ');
        this.logger.error(`[TRANSFER] Square rejected receive: ${errorMessage}`);
        return { synced: false, error: errorMessage };
      }

      return { synced: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TRANSFER] Failed to sync receive to Square: ${errorMessage}`);
      return { synced: false, error: errorMessage };
    }
  }

  async ship(input: ShipTransferInput) {
    if (input.quantity <= 0) {
      throw new BadRequestException('quantity must be positive');
    }
    if (input.fromLocationId === input.toLocationId) {
      throw new BadRequestException('fromLocationId and toLocationId must differ');
    }

    const [product, fromLocation, toLocation] = await Promise.all([
      this.prisma.product.findUnique({ where: { id: input.productId } }),
      this.prisma.location.findUnique({ where: { id: input.fromLocationId } }),
      this.prisma.location.findUnique({ where: { id: input.toLocationId } }),
    ]);
    if (!product) throw new NotFoundException(`Product ${input.productId} not found`);
    if (!fromLocation) throw new NotFoundException(`Location ${input.fromLocationId} not found`);
    if (!toLocation) throw new NotFoundException(`Location ${input.toLocationId} not found`);

    const reason = input.reason ?? `Transfer to ${toLocation.name}`;

    // Consume FIFO from the origin — existing machinery, already returns a
    // per-batch breakdown (consumptions) that's exactly what we need to
    // build one-lot-per-line TransferLines without re-deriving anything.
    const outResult = await this.adjustments.createAdjustment({
      locationId: input.fromLocationId,
      productId: input.productId,
      type: 'TRANSFER_OUT',
      quantity: -input.quantity,
      reason,
      notes: input.notes,
      syncToSquare: input.syncToSquare,
      adjustedBy: input.createdBy,
    });

    const consumptions = outResult.consumptions ?? [];
    const sourceLots = await this.prisma.inventory.findMany({
      where: { id: { in: consumptions.map((c) => c.inventoryId) } },
      select: { id: true, receivedAt: true },
    });
    const receivedAtById = new Map(sourceLots.map((l) => [l.id, l.receivedAt]));

    const lineDrafts = buildTransferLines(
      consumptions.map((c) => ({
        inventoryId: c.inventoryId,
        quantity: c.quantity,
        unitCost: Number(c.unitCost),
        receivedAt: receivedAtById.get(c.inventoryId)!,
      })),
    );

    let transfer;
    try {
      transfer = await this.prisma.transfer.create({
        data: {
          productId: input.productId,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          quantity: input.quantity,
          status: 'IN_TRANSIT',
          shippedAt: new Date(),
          createdBy: input.createdBy,
          lines: { create: lineDrafts },
        },
        include: { lines: true },
      });
    } catch (error) {
      // Known gap, matches break-bulk's precedent: the ship-side adjustment
      // already committed (stock is decremented) before this call — if
      // creating the Transfer record itself fails, that stock is orphaned
      // until reconciled manually. Surfaced clearly, not swallowed.
      this.logger.error(
        `[TRANSFER] Consumed ${input.quantity} of ${input.productId} at ${input.fromLocationId} (adjustment ${outResult.adjustment.id}) but failed to create the Transfer record — reconcile manually. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    this.logger.log(`[TRANSFER] Shipped ${input.quantity} of ${input.productId} from ${input.fromLocationId} to ${input.toLocationId} as transfer ${transfer.id} (${lineDrafts.length} lot(s))`);

    return { transfer, shipAdjustment: outResult };
  }

  async receive(input: ReceiveTransferInput) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: input.transferId },
      include: { lines: true },
    });
    if (!transfer) {
      throw new NotFoundException(`Transfer ${input.transferId} not found`);
    }
    if (transfer.status !== 'IN_TRANSIT') {
      throw new BadRequestException(`Transfer ${input.transferId} is ${transfer.status}, not IN_TRANSIT`);
    }

    const overrideByLineId = new Map((input.lineReceipts ?? []).map((r) => [r.transferLineId, r.quantityReceived]));
    const now = new Date();
    let totalReceived = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const line of transfer.lines) {
        const quantityReceived = resolveQuantityReceived(line.quantity, overrideByLineId.get(line.id));
        if (quantityReceived > line.quantity) {
          throw new BadRequestException(
            `quantityReceived (${quantityReceived}) exceeds quantity shipped (${line.quantity}) for line ${line.id}`,
          );
        }
        if (quantityReceived <= 0) {
          await tx.transferLine.update({ where: { id: line.id }, data: { quantityReceived: 0 } });
          continue;
        }

        // One destination lot per source lot — preserves this line's own
        // cost and original receivedAt, never blended with other lines.
        const batch = await tx.inventory.create({
          data: {
            locationId: transfer.toLocationId,
            productId: transfer.productId,
            quantity: quantityReceived,
            unitCost: line.unitCost,
            receivedAt: line.originalReceivedAt,
            source: 'ADJUSTMENT',
          },
        });

        await tx.inventoryAdjustment.create({
          data: {
            locationId: transfer.toLocationId,
            productId: transfer.productId,
            type: 'TRANSFER_IN',
            quantity: quantityReceived,
            unitCost: line.unitCost,
            totalCost: line.unitCost.mul(quantityReceived),
            createdBatchId: batch.id,
            reason: `Transfer ${transfer.id} receive`,
            effectiveDate: now,
            adjustedBy: input.receivedBy,
          },
        });

        await tx.transferLine.update({
          where: { id: line.id },
          data: { quantityReceived, destinationInventoryId: batch.id },
        });
        totalReceived += quantityReceived;
      }

      await tx.transfer.update({ where: { id: transfer.id }, data: { status: 'RECEIVED', receivedAt: now } });
    });

    let squareSync: { synced: boolean; error?: string } | undefined;
    if (input.syncToSquare && totalReceived > 0) {
      squareSync = await this.syncReceiveToSquare(transfer.id, transfer.toLocationId, transfer.productId, totalReceived);
    }

    this.logger.log(`[TRANSFER] Received ${totalReceived} of ${transfer.productId} at ${transfer.toLocationId} for transfer ${transfer.id}`);

    const updated = await this.prisma.transfer.findUniqueOrThrow({
      where: { id: transfer.id },
      include: { lines: true },
    });
    return { transfer: updated, totalReceived, squareSync };
  }

  async getTransfers(options: { locationId?: string; status?: string }) {
    const where: any = {};
    if (options.locationId) {
      where.OR = [{ fromLocationId: options.locationId }, { toLocationId: options.locationId }];
    }
    if (options.status) {
      where.status = options.status;
    }
    return this.prisma.transfer.findMany({
      where,
      include: {
        lines: true,
        product: { select: { id: true, name: true, sku: true } },
        fromLocation: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
