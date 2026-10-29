import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { assertCutOver } from './cutover-gate';
import { buildTransferLines, resolveQuantityReceived } from './transfer';
import { SquareClient } from 'square';
import { createSquareClient } from '../square/square-client';
import { sendInventoryChanges } from './square-sync';

export interface ShipTransferInput {
  productId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  reason?: string;
  notes?: string;
  createdBy?: string;
}

export interface ReceiveTransferInput {
  transferId: string;
  lineReceipts?: { transferLineId: string; quantityReceived: number }[];
  syncToSquare?: boolean;
  receivedBy?: string;
  /** Throws unless the caller may receive at this location (the transfer's destination). */
  assertAccess?: (toLocationId: string) => void;
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
    return (this.squareClient ??= createSquareClient());
  }

  /**
   * Tells Square about a received transfer in one call: the received units move
   * between the two locations (IN_STOCK → IN_STOCK), and any shortfall — lost in
   * transit — is waste at the origin. The shipment itself isn't pushed, so
   * Square holds the units at the origin until now.
   */
  private async syncReceiveToSquare(
    transfer: { id: string; fromLocationId: string; toLocationId: string; productId: string; quantity: number },
    received: number,
  ): Promise<{ synced: boolean; error?: string }> {
    const client = this.getSquareClient();
    if (!client) return { synced: false, error: 'Square client not configured' };

    try {
      const locations = await this.prisma.location.findMany({
        where: { id: { in: [transfer.fromLocationId, transfer.toLocationId] } },
        select: { id: true, squareId: true },
      });
      const squareIdOf = new Map(locations.map((l) => [l.id, l.squareId]));
      const from = squareIdOf.get(transfer.fromLocationId);
      const to = squareIdOf.get(transfer.toLocationId);
      if (!from || !to) return { synced: false, error: 'Location not linked to Square' };

      const catalogMapping = await this.prisma.catalogMapping.findFirst({
        where: { productId: transfer.productId },
        select: { squareVariationId: true },
      });
      if (!catalogMapping?.squareVariationId) return { synced: false, error: 'Product not mapped to Square catalog' };

      const occurredAt = new Date().toISOString();
      const change = (
        fromLocationId: string, toLocationId: string, toState: 'IN_STOCK' | 'WASTE', quantity: number, reference: string,
      ) => ({
        type: 'ADJUSTMENT' as const,
        adjustment: {
          catalogObjectId: catalogMapping.squareVariationId,
          fromLocationId,
          toLocationId,
          fromState: 'IN_STOCK' as const,
          toState,
          quantity: quantity.toString(),
          occurredAt,
          referenceId: `transfer-${reference}-${transfer.id}`,
        },
      });
      const lost = transfer.quantity - received;
      const changes = [
        ...(received > 0 ? [change(from, to, 'IN_STOCK', received, 'receive')] : []),
        ...(lost > 0 ? [change(from, from, 'WASTE', lost, 'lost')] : []),
      ];
      if (changes.length === 0) return { synced: true };

      return await sendInventoryChanges(client, {
        // Keyed on the transfer itself (not randomUUID()) so a retry
        // (retrySquareSync) replays the same key — Square returns the
        // original result instead of double-applying the stock change.
        idempotencyKey: transfer.id,
        changes,
      }, this.logger, 'transfer receive');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TRANSFER] Failed to sync receive to Square: ${errorMessage}`);
      return { synced: false, error: errorMessage };
    }
  }

  async ship(input: ShipTransferInput) {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('La cantidad debe ser un número entero mayor que cero');
    }
    if (input.fromLocationId === input.toLocationId) {
      throw new BadRequestException('La sucursal de origen y la de destino deben ser distintas');
    }

    const [product, fromLocation, toLocation] = await Promise.all([
      this.prisma.product.findUnique({ where: { id: input.productId } }),
      this.prisma.location.findUnique({ where: { id: input.fromLocationId } }),
      this.prisma.location.findUnique({ where: { id: input.toLocationId } }),
    ]);
    if (!product) throw new NotFoundException(`Product ${input.productId} not found`);
    if (!fromLocation) throw new NotFoundException(`Location ${input.fromLocationId} not found`);
    if (!toLocation) throw new NotFoundException(`Location ${input.toLocationId} not found`);
    // The origin is checked by its TRANSFER_OUT adjustment; the destination would
    // otherwise receive stock its cutover will count again.
    await assertCutOver(this.prisma, input.toLocationId);

    const reason = input.reason ?? `Transfer to ${toLocation.name}`;

    // Consume FIFO from the origin and record the transfer in one transaction,
    // so stock never leaves the origin without a transfer carrying it. The
    // adjustment's per-batch consumptions become one TransferLine per lot.
    const { outResult, transfer } = await this.prisma.$transaction(async (tx) => {
      const outResult = await this.adjustments.createAdjustment({
        locationId: input.fromLocationId,
        productId: input.productId,
        type: 'TRANSFER_OUT',
        quantity: -input.quantity,
        reason,
        notes: input.notes,
        adjustedBy: input.createdBy,
      }, tx);

      const consumptions = outResult.consumptions ?? [];
      const sourceLots = await tx.inventory.findMany({
        where: { id: { in: consumptions.map((c) => c.inventoryId) } },
        select: { id: true, receivedAt: true },
      });
      const receivedAtById = new Map(sourceLots.map((l) => [l.id, l.receivedAt]));

      const transfer = await tx.transfer.create({
        data: {
          productId: input.productId,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          quantity: input.quantity,
          status: 'IN_TRANSIT',
          shippedAt: new Date(),
          createdBy: input.createdBy,
          lines: {
            create: buildTransferLines(
              consumptions.map((c) => ({
                inventoryId: c.inventoryId,
                quantity: c.quantity,
                unitCost: Number(c.unitCost),
                receivedAt: receivedAtById.get(c.inventoryId)!,
              })),
            ),
          },
        },
        include: { lines: true },
      });
      return { outResult, transfer };
    });

    this.logger.log(`[TRANSFER] Shipped ${input.quantity} of ${input.productId} from ${input.fromLocationId} to ${input.toLocationId} as transfer ${transfer.id} (${transfer.lines.length} lot(s))`);

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
    input.assertAccess?.(transfer.toLocationId);
    if (transfer.status !== 'IN_TRANSIT') {
      throw new BadRequestException(`La transferencia ${input.transferId} está ${transfer.status}; solo se puede recibir una en tránsito`);
    }

    const lineIds = new Set(transfer.lines.map((l) => l.id));
    for (const r of input.lineReceipts ?? []) {
      if (!lineIds.has(r.transferLineId)) {
        throw new BadRequestException(`La línea ${r.transferLineId} no pertenece a la transferencia ${input.transferId}`);
      }
      if (!Number.isInteger(r.quantityReceived) || r.quantityReceived < 0) {
        throw new BadRequestException(`La cantidad recibida en la línea ${r.transferLineId} debe ser un número entero, cero o mayor`);
      }
    }
    const overrideByLineId = new Map((input.lineReceipts ?? []).map((r) => [r.transferLineId, r.quantityReceived]));
    const now = new Date();
    let totalReceived = 0;

    await this.prisma.$transaction(async (tx) => {
      // Claim the transfer first: a second receive racing past the check above
      // (double tap, offline replay) finds it no longer in transit and rolls
      // back instead of creating the destination stock again.
      const { count } = await tx.transfer.updateMany({
        where: { id: transfer.id, status: 'IN_TRANSIT' },
        data: { status: 'RECEIVED', receivedAt: now },
      });
      if (count === 0) {
        throw new ConflictException(`La transferencia ${input.transferId} ya se recibió`);
      }

      for (const line of transfer.lines) {
        const quantityReceived = resolveQuantityReceived(line.quantity, overrideByLineId.get(line.id));
        if (quantityReceived > line.quantity) {
          throw new BadRequestException(
            `La cantidad recibida (${quantityReceived}) es mayor que la enviada (${line.quantity}) en la línea ${line.id}`,
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
    });

    const squareSync = input.syncToSquare ? await this.recordSquareSync(transfer, totalReceived) : undefined;

    this.logger.log(`[TRANSFER] Received ${totalReceived} of ${transfer.productId} at ${transfer.toLocationId} for transfer ${transfer.id}`);

    const updated = await this.prisma.transfer.findUniqueOrThrow({
      where: { id: transfer.id },
      include: { lines: true },
    });
    return { transfer: updated, totalReceived, squareSync };
  }

  /**
   * Resends a received transfer whose Square sync failed. Only a recorded
   * failure is retried: a receipt never sent (or received before results were
   * recorded) may already be in Square.
   */
  async retrySquareSync(transferId: string): Promise<{ synced: boolean; error?: string }> {
    const transfer = await this.prisma.transfer.findUnique({ where: { id: transferId }, include: { lines: true } });
    if (!transfer) {
      throw new NotFoundException(`Transfer ${transferId} not found`);
    }
    if (transfer.squareSynced) {
      return { synced: true };
    }
    if (transfer.status !== 'RECEIVED' || !transfer.squareSyncError) {
      throw new BadRequestException('Esta transferencia no tiene un envío fallido a Square que reintentar');
    }
    const received = transfer.lines.reduce((sum, l) => sum + (l.quantityReceived ?? 0), 0);
    return this.recordSquareSync(transfer, received);
  }

  /** Sends a received transfer to Square and records the outcome on it. */
  private async recordSquareSync(
    transfer: Parameters<TransferService['syncReceiveToSquare']>[0],
    received: number,
  ): Promise<{ synced: boolean; error?: string }> {
    const result = await this.syncReceiveToSquare(transfer, received);
    await this.prisma.transfer.update({
      where: { id: transfer.id },
      data: {
        squareSynced: result.synced,
        squareSyncedAt: result.synced ? new Date() : null,
        squareSyncError: result.error ?? null,
      },
    });
    return result;
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
