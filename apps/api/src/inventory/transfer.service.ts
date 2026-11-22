import { Injectable, Logger, BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { Prisma, TransferStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { listLimit } from './list-limit';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { assertCutOver } from './cutover-gate';
import { assertSoldAtLocation } from './sold-at-location';
import { buildTransferLines, resolveQuantityReceived } from './transfer';
import { Square, SquareClient, SquareError } from 'square';
import { createSquareClient } from '../square/square-client';
import { preferredMapping, sendInventoryChanges, type SquareSyncResult } from './square-sync';
import { transferSuggestions } from './transfer-suggestions';

type SquareReceipt = {
  transfer: { id: string; fromLocationId: string; toLocationId: string; productId: string; quantity: number };
  received: number;
};

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

export interface ShipBatchInput {
  fromLocationId: string;
  toLocationId: string;
  clientRequestId: string;
  receiveOnSend: boolean;
  items: { productId: string; quantity: number }[];
  createdBy?: string;
}

export interface ReceiveShipmentInput {
  shipmentId: string;
  lineReceipts?: { transferLineId: string; quantityReceived: number }[];
  receivedBy?: string;
  /** Throws unless the caller may receive at this location (the shipment's destination). */
  assertAccess?: (toLocationId: string) => void;
}

export type ShipmentStatus = 'IN_TRANSIT' | 'RECEIVED';

const MAX_SHIPMENT_ITEMS = 100;

/** The source lot fields a received line copies onto its destination lot. */
const linesSource = { sourceInventory: { select: { expiryDate: true, lotNumber: true } } } as const;

type ShippedTransfer = Prisma.TransferGetPayload<{ include: { lines: { include: typeof linesSource } } }>;

const shipmentInclude = {
  fromLocation: { select: { id: true, name: true } },
  toLocation: { select: { id: true, name: true } },
  transfers: {
    orderBy: { createdAt: 'asc' },
    include: { lines: true, product: { select: { id: true, name: true, sku: true, squareImageUrl: true } } },
  },
} satisfies Prisma.ShipmentInclude;

/** In transit while any of its transfers is; each can still be received on its own. */
const withStatus = <S extends { transfers: { status: TransferStatus }[] }>(shipment: S) => ({
  ...shipment,
  status: (shipment.transfers.some((t) => t.status === 'IN_TRANSIT') ? 'IN_TRANSIT' : 'RECEIVED') as ShipmentStatus,
});

/** A 400 with a stable code the phone can branch on. */
const refusal = (code: string, message: string, extra: object = {}) =>
  new BadRequestException({ success: false, code, message, ...extra });

/** Adds the product a refusal is about, so a batch says which item failed. */
const named = (productId: string, error: unknown) =>
  error instanceof HttpException && typeof error.getResponse() === 'object'
    ? new HttpException({ ...(error.getResponse() as object), productId }, error.getStatus())
    : error;
const naming = (productId: string, check: () => void) => {
  try { check(); } catch (error) { throw named(productId, error); }
};
const namingAsync = async <T>(productId: string, work: () => Promise<T>) => {
  try { return await work(); } catch (error) { throw named(productId, error); }
};

/** Validates per-line receipts against the lines being received; returns overrides by line id. */
function checkedReceipts(
  lines: { id: string; quantity: number }[],
  receipts: { transferLineId: string; quantityReceived: number }[] | undefined,
  what: string,
): Map<string, number> {
  const shippedByLineId = new Map(lines.map((l) => [l.id, l.quantity]));
  for (const r of receipts ?? []) {
    const shipped = shippedByLineId.get(r.transferLineId);
    if (shipped === undefined) {
      throw new BadRequestException(`La línea ${r.transferLineId} no pertenece a ${what}`);
    }
    if (!Number.isInteger(r.quantityReceived) || r.quantityReceived < 0) {
      throw new BadRequestException(`La cantidad recibida en la línea ${r.transferLineId} debe ser un número entero, cero o mayor`);
    }
    if (r.quantityReceived > shipped) {
      throw new BadRequestException(
        `La cantidad recibida (${r.quantityReceived}) es mayor que la enviada (${shipped}) en la línea ${r.transferLineId}`,
      );
    }
  }
  return new Map((receipts ?? []).map((r) => [r.transferLineId, r.quantityReceived]));
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
   * Tells Square about a received transfer in one call: the received units
   * leave the origin (IN_STOCK → NONE) and arrive at the destination
   * (NONE → IN_STOCK), and any shortfall — lost in transit — is waste at the
   * origin. Every change stays at one location: a move between locations
   * (IN_STOCK → IN_STOCK) is a Square transfer, which needs a paid plan
   * (MERCHANT_SUBSCRIPTION_NOT_FOUND). The shipment itself isn't pushed, so
   * Square holds the units at the origin until now.
   */
  private async squareChanges(receipts: SquareReceipt[]): Promise<Array<{ changes: Square.InventoryChange[] } | { error: string }>> {
    const locationIds = [...new Set(receipts.flatMap(({ transfer: t }) => [t.fromLocationId, t.toLocationId]))];
    const [locations, mappings] = await Promise.all([
      this.prisma.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, squareId: true } }),
      this.prisma.catalogMapping.findMany({
        where: { productId: { in: receipts.map(({ transfer: t }) => t.productId) }, NOT: { squareVariationId: { startsWith: 'local_' } } },
        select: { productId: true, squareVariationId: true, locationId: true },
      }),
    ]);
    const squareIdOf = new Map(locations.map((l) => [l.id, l.squareId]));
    // Each store's change names the variation that store maps to (same pick as findSquareVariationId).
    const variationAt = (productId: string, locationId: string) =>
      preferredMapping(mappings.filter((m) => m.productId === productId), locationId)?.squareVariationId;
    const occurredAt = new Date().toISOString();

    return receipts.map(({ transfer, received }) => {
      const from = squareIdOf.get(transfer.fromLocationId);
      const to = squareIdOf.get(transfer.toLocationId);
      if (!from || !to) return { error: 'Location not linked to Square' };
      const fromVariationId = variationAt(transfer.productId, transfer.fromLocationId);
      const toVariationId = variationAt(transfer.productId, transfer.toLocationId);
      if (!fromVariationId || !toVariationId) return { error: 'Product not mapped to Square catalog' };

      const change = (
        catalogObjectId: string, locationId: string,
        fromState: 'IN_STOCK' | 'NONE', toState: 'IN_STOCK' | 'NONE' | 'WASTE', quantity: number, reference: string,
      ): Square.InventoryChange => ({
        type: 'ADJUSTMENT',
        adjustment: {
          catalogObjectId,
          fromLocationId: locationId,
          toLocationId: locationId,
          fromState,
          toState,
          quantity: quantity.toString(),
          occurredAt,
          referenceId: `transfer-${reference}-${transfer.id}`,
        },
      });
      const lost = transfer.quantity - received;
      return {
        changes: [
          ...(received > 0
            ? [
                change(fromVariationId, from, 'IN_STOCK', 'NONE', received, 'out'),
                change(toVariationId, to, 'NONE', 'IN_STOCK', received, 'in'),
              ]
            : []),
          ...(lost > 0 ? [change(fromVariationId, from, 'IN_STOCK', 'WASTE', lost, 'lost')] : []),
        ],
      };
    });
  }

  /**
   * Tells Square about received transfers in as few calls as it takes (at
   * most 100 changes each, a transfer's changes never split). Per transfer,
   * the received units leave the origin (IN_STOCK → NONE) and arrive at the
   * destination (NONE → IN_STOCK), and any shortfall — lost in transit — is
   * waste at the origin. Every change stays at one location: a move between
   * locations (IN_STOCK → IN_STOCK) is a Square transfer, which needs a paid
   * plan (MERCHANT_SUBSCRIPTION_NOT_FOUND). The shipment itself isn't pushed,
   * so Square holds the units at the origin until now.
   *
   * A transfer sent alone is keyed on itself, so retrySquareSync replays the
   * same key and Square answers with the first result instead of applying it
   * twice (':adjust' leaves the key of the old between-stores move). A call
   * Square rejects applies nothing, so its transfers are resent alone, each
   * keeping its own outcome. A call that fails without an answer may have
   * applied; it isn't resent, and retrySquareSync checks Square first.
   */
  private async syncReceivesToSquare(receipts: SquareReceipt[]): Promise<SquareSyncResult[]> {
    const client = this.getSquareClient();
    if (!client) return receipts.map(() => ({ synced: false, error: 'Square client not configured' }));
    const failed = (error: unknown): SquareSyncResult => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TRANSFER] Failed to sync receive to Square: ${message}`);
      return { synced: false, error: message };
    };

    let built: Awaited<ReturnType<TransferService['squareChanges']>>;
    try {
      built = await this.squareChanges(receipts);
    } catch (error) {
      return receipts.map(() => failed(error));
    }
    const results: SquareSyncResult[] = built.map((b) => ('error' in b ? { synced: false, error: b.error } : { synced: true }));

    const send = (indexes: number[]) =>
      sendInventoryChanges(client, {
        idempotencyKey: indexes.length === 1 ? `${receipts[indexes[0]].transfer.id}:adjust` : `${receipts[indexes[0]].transfer.id}:batch:${indexes.length}`,
        changes: indexes.flatMap((i) => (built[i] as { changes: Square.InventoryChange[] }).changes),
      }, this.logger, indexes.length === 1 ? 'transfer receive' : `${indexes.length} transfer receives`);

    const chunks: number[][] = [];
    let size = 0;
    built.forEach((b, i) => {
      if ('error' in b || b.changes.length === 0) return;
      if (chunks.length === 0 || size + b.changes.length > 100) (chunks.push([]), (size = 0));
      chunks[chunks.length - 1].push(i);
      size += b.changes.length;
    });

    for (const chunk of chunks) {
      let outcome: SquareSyncResult;
      try {
        outcome = await send(chunk);
      } catch (error) {
        const rejected = error instanceof SquareError && error.statusCode !== undefined && error.statusCode < 500;
        if (!rejected || chunk.length === 1) {
          for (const i of chunk) results[i] = failed(error);
          continue;
        }
        outcome = { synced: false };
      }
      if (outcome.synced || chunk.length === 1) {
        for (const i of chunk) results[i] = outcome;
        continue;
      }
      for (const i of chunk) results[i] = await send([i]).catch(failed);
    }
    return results;
  }

  /** Whether Square already holds a change sent for this transfer (by its reference ids). */
  private async inSquareAlready(transfer: SquareReceipt['transfer'], received: number, since: Date): Promise<boolean> {
    const client = this.getSquareClient();
    const [built] = await this.squareChanges([{ transfer, received }]);
    if (!client || 'error' in built || built.changes.length === 0) return false;
    const adjustments = built.changes.map((c) => c.adjustment!);
    const references = new Set(adjustments.map((a) => a.referenceId));
    const changes = await client.inventory.batchGetChanges({
      catalogObjectIds: [...new Set(adjustments.map((a) => a.catalogObjectId!))],
      locationIds: [...new Set(adjustments.map((a) => a.toLocationId!))],
      types: ['ADJUSTMENT'],
      updatedAfter: new Date(since.getTime() - 5 * 60_000).toISOString(), // slack for clock skew
    });
    for await (const change of changes) if (references.has(change.adjustment?.referenceId)) return true;
    return false;
  }

  /** What a store can send to the others; see transferSuggestions. */
  suggestions(o: { fromLocationId: string; toLocationId?: string; productIds?: string[] }) {
    return transferSuggestions(this.prisma, o);
  }

  async ship(input: ShipTransferInput) {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw refusal('INVALID_QUANTITY', 'La cantidad debe ser un número entero mayor que cero');
    }
    if (input.fromLocationId === input.toLocationId) {
      throw refusal('SAME_LOCATION', 'La sucursal de origen y la de destino deben ser distintas');
    }

    const [product, fromLocation, toLocation] = await Promise.all([
      this.prisma.product.findUnique({ where: { id: input.productId } }),
      this.prisma.location.findUnique({ where: { id: input.fromLocationId } }),
      this.prisma.location.findUnique({ where: { id: input.toLocationId } }),
    ]);
    if (!product) throw new NotFoundException(`Product ${input.productId} not found`);
    if (!fromLocation) throw new NotFoundException(`Location ${input.fromLocationId} not found`);
    if (!toLocation) throw new NotFoundException(`Location ${input.toLocationId} not found`);
    assertSoldAtLocation(product, input.toLocationId);
    // The origin is checked by its TRANSFER_OUT adjustment; the destination would
    // otherwise receive stock its cutover will count again.
    await assertCutOver(this.prisma, input.toLocationId, undefined, 'DESTINATION_NOT_CUT_OVER');

    const { outResult, transfer } = await this.prisma.$transaction((tx) => this.shipIn(tx, input, toLocation.name));

    this.logger.log(`[TRANSFER] Shipped ${input.quantity} of ${input.productId} from ${input.fromLocationId} to ${input.toLocationId} as transfer ${transfer.id} (${transfer.lines.length} lot(s))`);

    return { transfer, shipAdjustment: outResult };
  }

  /**
   * Consumes FIFO from the origin and records the transfer, inside the caller's
   * transaction, so stock never leaves the origin without a transfer carrying
   * it. The adjustment's per-batch consumptions become one TransferLine per lot.
   */
  private async shipIn(tx: Prisma.TransactionClient, input: ShipTransferInput & { shipmentId?: string }, toLocationName: string) {
    const outResult = await this.adjustments.createAdjustment({
      locationId: input.fromLocationId,
      productId: input.productId,
      type: 'TRANSFER_OUT',
      quantity: -input.quantity,
      reason: input.reason ?? `Transfer to ${toLocationName}`,
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
        shipmentId: input.shipmentId,
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
      include: { lines: { include: linesSource } },
    });
    return { outResult, transfer };
  }

  async receive(input: ReceiveTransferInput) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: input.transferId },
      include: { lines: { include: linesSource } },
    });
    if (!transfer) {
      throw new NotFoundException(`Transfer ${input.transferId} not found`);
    }
    input.assertAccess?.(transfer.toLocationId);
    if (transfer.status !== 'IN_TRANSIT') {
      throw new BadRequestException(`La transferencia ${input.transferId} está ${transfer.status}; solo se puede recibir una en tránsito`);
    }

    const overrides = checkedReceipts(transfer.lines, input.lineReceipts, `la transferencia ${input.transferId}`);
    const totalReceived = await this.prisma.$transaction((tx) => this.receiveIn(tx, transfer, overrides, input.receivedBy));

    const squareSync = input.syncToSquare ? await this.recordSquareSync(transfer, totalReceived) : undefined;

    this.logger.log(`[TRANSFER] Received ${totalReceived} of ${transfer.productId} at ${transfer.toLocationId} for transfer ${transfer.id}`);

    const updated = await this.prisma.transfer.findUniqueOrThrow({
      where: { id: transfer.id },
      include: { lines: true },
    });
    return { transfer: updated, totalReceived, squareSync };
  }

  /**
   * Receives an in-transit transfer inside the caller's transaction: one
   * destination lot per source lot, each keeping its own cost and original
   * receivedAt. Returns the units received.
   */
  private async receiveIn(
    tx: Prisma.TransactionClient,
    transfer: ShippedTransfer,
    overrides: Map<string, number>,
    receivedBy: string | undefined,
  ): Promise<number> {
    // Claim the transfer first: a second receive racing past the caller's
    // check (double tap, offline replay) finds it no longer in transit and
    // rolls back instead of creating the destination stock again.
    const now = new Date();
    const { count } = await tx.transfer.updateMany({
      where: { id: transfer.id, status: 'IN_TRANSIT' },
      data: { status: 'RECEIVED', receivedAt: now },
    });
    if (count === 0) {
      throw new ConflictException(`La transferencia ${transfer.id} ya se recibió`);
    }

    let totalReceived = 0;
    for (const line of transfer.lines) {
      const quantityReceived = resolveQuantityReceived(line.quantity, overrides.get(line.id));
      if (quantityReceived <= 0) {
        await tx.transferLine.update({ where: { id: line.id }, data: { quantityReceived: 0 } });
        continue;
      }

      const batch = await tx.inventory.create({
        data: {
          locationId: transfer.toLocationId,
          productId: transfer.productId,
          quantity: quantityReceived,
          unitCost: line.unitCost,
          receivedAt: line.originalReceivedAt,
          source: 'ADJUSTMENT',
          expiryDate: line.sourceInventory.expiryDate,
          lotNumber: line.sourceInventory.lotNumber,
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
          adjustedBy: receivedBy,
        },
      });

      await tx.transferLine.update({
        where: { id: line.id },
        data: { quantityReceived, destinationInventoryId: batch.id },
      });
      totalReceived += quantityReceived;
    }
    return totalReceived;
  }

  /**
   * Sends several products to one store in one go, all or nothing, as a
   * shipment holding one transfer per product. A resend with the same
   * clientRequestId answers with the first shipment. With receiveOnSend the
   * destination gets the stock in the same transaction and Square is told
   * after it commits, once per transfer.
   */
  async shipBatch(input: ShipBatchInput) {
    if (!input.clientRequestId || typeof input.clientRequestId !== 'string') {
      throw new BadRequestException('clientRequestId is required');
    }
    const items = Array.isArray(input.items) ? input.items : [];
    if (items.length === 0) throw refusal('NO_ITEMS', 'Agrega al menos un producto');
    if (items.length > MAX_SHIPMENT_ITEMS) {
      throw refusal('TOO_MANY_ITEMS', `Una transferencia lleva hasta ${MAX_SHIPMENT_ITEMS} productos`);
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item?.productId !== 'string' || !item.productId) {
        throw refusal('INVALID_ITEM', 'Cada producto necesita su id y su cantidad');
      }
      const { productId, quantity } = item;
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw refusal('INVALID_QUANTITY', 'La cantidad debe ser un número entero mayor que cero', { productId });
      }
      if (seen.has(productId)) throw refusal('DUPLICATE_PRODUCT', 'Un producto está dos veces en la transferencia', { productId });
      seen.add(productId);
    }
    if (input.fromLocationId === input.toLocationId) {
      throw refusal('SAME_LOCATION', 'La sucursal de origen y la de destino deben ser distintas');
    }

    const sent = await this.replayOf(input);
    if (sent) return sent;

    const [fromLocation, toLocation, products] = await Promise.all([
      this.prisma.location.findUnique({ where: { id: input.fromLocationId } }),
      this.prisma.location.findUnique({ where: { id: input.toLocationId } }),
      this.prisma.product.findMany({ where: { id: { in: [...seen] } } }),
    ]);
    if (!fromLocation) throw new NotFoundException(`Location ${input.fromLocationId} not found`);
    if (!toLocation) throw new NotFoundException(`Location ${input.toLocationId} not found`);
    await assertCutOver(this.prisma, input.toLocationId, undefined, 'DESTINATION_NOT_CUT_OVER');
    const productById = new Map(products.map((p) => [p.id, p]));
    for (const { productId } of items) {
      const product = productById.get(productId);
      if (!product) throw new NotFoundException({ success: false, message: `Product ${productId} not found`, productId });
      naming(productId, () => assertSoldAtLocation(product, input.toLocationId));
    }

    let shipped: Awaited<ReturnType<TransferService['shipIn']>>['transfer'][];
    try {
      shipped = await this.prisma.$transaction(async (tx) => {
        const shipment = await tx.shipment.create({
          data: {
            fromLocationId: input.fromLocationId,
            toLocationId: input.toLocationId,
            receiveOnSend: input.receiveOnSend,
            clientRequestId: input.clientRequestId,
            createdBy: input.createdBy,
          },
        });
        const transfers = [];
        // Stock is taken in product id order, so overlapping sends lock the origin's lots in the
        // same order instead of deadlocking.
        // ponytail: one transaction for up to 100 products holds those lots until it commits; a sale
        // on one of them waits and may hit its own transaction timeout and retry. Split the send into
        // smaller transactions if that shows up.
        const inLockOrder = [...items].sort((x, y) => (x.productId < y.productId ? -1 : x.productId > y.productId ? 1 : 0));
        for (const { productId, quantity } of inLockOrder) {
          const { transfer } = await namingAsync(productId, () =>
            this.shipIn(tx, { productId, quantity, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId, createdBy: input.createdBy, shipmentId: shipment.id }, toLocation.name),
          );
          if (input.receiveOnSend) await this.receiveIn(tx, transfer, new Map(), input.createdBy);
          transfers.push(transfer);
        }
        return transfers;
      }, { timeout: 60_000 });
    } catch (error) {
      // Two copies of the same send raced past the lookup; the loser hit the unique key.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.replayOf(input);
        if (raced) return raced;
      }
      throw error;
    }

    if (input.receiveOnSend) {
      await this.recordSquareSyncs(shipped.map((transfer) => ({ transfer, received: transfer.quantity })));
    }
    this.logger.log(`[TRANSFER] Shipped ${shipped.length} product(s) from ${input.fromLocationId} to ${input.toLocationId}${input.receiveOnSend ? ', received on send' : ''}`);
    return (await this.findShipment({ clientRequestId: input.clientRequestId }))!;
  }

  /**
   * Receives every transfer of a shipment still in transit, at its sent
   * quantity unless a line is counted otherwise. One already received on its
   * own is skipped; none left is a conflict.
   */
  async receiveShipment(input: ReceiveShipmentInput) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: input.shipmentId },
      include: { transfers: { where: { status: 'IN_TRANSIT' }, include: { lines: { include: linesSource } } } },
    });
    if (!shipment) throw new NotFoundException(`Shipment ${input.shipmentId} not found`);
    input.assertAccess?.(shipment.toLocationId);
    if (shipment.transfers.length === 0) throw new ConflictException('Esta transferencia ya se recibió');

    const overrides = checkedReceipts(shipment.transfers.flatMap((t) => t.lines), input.lineReceipts, 'esta transferencia');
    const received = await this.prisma.$transaction(async (tx) => {
      const totals = [];
      for (const transfer of shipment.transfers) totals.push(await this.receiveIn(tx, transfer, overrides, input.receivedBy));
      return totals;
    }, { timeout: 60_000 });

    await this.recordSquareSyncs(shipment.transfers.map((transfer, i) => ({ transfer, received: received[i] })));
    this.logger.log(`[TRANSFER] Received shipment ${shipment.id} at ${shipment.toLocationId}`);
    return (await this.findShipment({ id: shipment.id }))!;
  }

  /**
   * On hand at a store by product id: the sum of the store's lots, the figure
   * getProduct(id, locationId) reports as totalInventory. An id with no product is left out.
   */
  async stockAt(locationId: string, productIds: string[]): Promise<Record<string, number>> {
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, inventories: { where: { locationId }, select: { quantity: true } } },
    });
    return Object.fromEntries(products.map((p) => [p.id, p.inventories.reduce((sum, inv) => sum + inv.quantity, 0)]));
  }

  /** Shipments to or from a store (or all), newest first, by the status their transfers give them. */
  async getShipments(options: { locationId?: string; status?: ShipmentStatus }) {
    const shipments = await this.prisma.shipment.findMany({
      where: {
        ...(options.locationId && { OR: [{ fromLocationId: options.locationId }, { toLocationId: options.locationId }] }),
        ...(options.status === 'IN_TRANSIT' && { transfers: { some: { status: 'IN_TRANSIT' } } }),
        ...(options.status === 'RECEIVED' && { transfers: { none: { status: 'IN_TRANSIT' } } }),
      },
      include: shipmentInclude,
      orderBy: [{ shippedAt: 'desc' }, { id: 'asc' }],
      take: listLimit(undefined),
    });
    return shipments.map(withStatus);
  }

  /** The shipment a resend already made, refusing one another store's send made with that id. */
  private async replayOf(input: ShipBatchInput) {
    const sent = await this.findShipment({ clientRequestId: input.clientRequestId });
    if (sent && sent.fromLocationId !== input.fromLocationId) {
      throw new ConflictException({ success: false, code: 'CLIENT_REQUEST_ID_REUSED', message: 'clientRequestId was already used by another store' });
    }
    return sent;
  }

  private async findShipment(where: Prisma.ShipmentWhereUniqueInput) {
    const shipment = await this.prisma.shipment.findUnique({ where, include: shipmentInclude });
    return shipment && withStatus(shipment);
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
    // Sent with its shipment, the call may have reached Square without an answer: don't apply it twice.
    if (transfer.shipmentId && transfer.receivedAt) {
      const already = await this.inSquareAlready(transfer, received, transfer.receivedAt).catch((error: unknown) =>
        ({ synced: false, error: error instanceof Error ? error.message : String(error) }));
      if (already !== false) {
        const result = already === true ? { synced: true } : already;
        await this.recordSquareResults([transfer], [result]);
        return result;
      }
    }
    return this.recordSquareSync(transfer, received);
  }

  /** Sends a received transfer to Square and records the outcome on it. */
  private async recordSquareSync(transfer: SquareReceipt['transfer'], received: number): Promise<SquareSyncResult> {
    return (await this.recordSquareSyncs([{ transfer, received }]))[0];
  }

  /** Sends received transfers to Square together and records each one's outcome on it. */
  private async recordSquareSyncs(receipts: SquareReceipt[]): Promise<SquareSyncResult[]> {
    const results = await this.syncReceivesToSquare(receipts);
    await this.recordSquareResults(receipts.map((r) => r.transfer), results);
    return results;
  }

  private async recordSquareResults(transfers: { id: string }[], results: SquareSyncResult[]) {
    const now = new Date();
    await this.prisma.$transaction(transfers.map((t, i) =>
      this.prisma.transfer.update({
        where: { id: t.id },
        data: { squareSynced: results[i].synced, squareSyncedAt: results[i].synced ? now : null, squareSyncError: results[i].error ?? null },
      })));
  }

  async getTransfers(options: { locationId?: string; status?: TransferStatus }) {
    return this.prisma.transfer.findMany({
      where: {
        ...(options.locationId && { OR: [{ fromLocationId: options.locationId }, { toLocationId: options.locationId }] }),
        ...(options.status && { status: options.status }),
      },
      include: {
        lines: true,
        product: { select: { id: true, name: true, sku: true } },
        fromLocation: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: listLimit(undefined),
    });
  }
}
