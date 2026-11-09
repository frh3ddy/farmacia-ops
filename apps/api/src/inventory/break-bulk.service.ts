import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { looseUnitsFromBoxes, costPerLooseUnit } from './break-bulk';

export interface BreakBulkInput {
  boxProductId: string;
  locationId: string;
  boxQuantity: number;
  reason?: string;
  notes?: string;
  syncToSquare?: boolean;
  adjustedBy?: string;
}

/**
 * "Open a box, add it as loose stock" — the box and loose products are
 * two already-separate, already-existing Products/Square items (not
 * variations of one item); this just moves cost-preserved stock between
 * them, same as the owner's manual today's-workflow (open a box, recount in
 * Square, add the new loose stock) but automated and cost-tracked.
 *
 * Reuses InventoryAdjustmentService.createAdjustment for both legs — same
 * FIFO consumption / batch creation / Square-sync code already used for
 * every other adjustment type, no new inventory-mutation logic here. Both
 * legs commit in one transaction; Square hears about them only after.
 */
@Injectable()
export class BreakBulkService {
  private readonly logger = new Logger(BreakBulkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adjustments: InventoryAdjustmentService,
  ) {}

  async breakBulk(input: BreakBulkInput) {
    if (!Number.isInteger(input.boxQuantity) || input.boxQuantity <= 0) {
      throw new BadRequestException('La cantidad de cajas debe ser un número entero mayor que cero');
    }

    const boxProduct = await this.prisma.product.findUnique({ where: { id: input.boxProductId } });
    if (!boxProduct) {
      throw new NotFoundException(`Product ${input.boxProductId} not found`);
    }
    const link = await this.prisma.productLooseLink.findUnique({
      where: { locationId_boxProductId: { locationId: input.locationId, boxProductId: input.boxProductId } },
    });
    if (!link) {
      const store = await this.prisma.location.findUnique({ where: { id: input.locationId }, select: { name: true } });
      throw new BadRequestException(`${boxProduct.name} no tiene suelto vinculado en ${store?.name ?? 'esta sucursal'}. Vincúlalo primero.`);
    }
    if (!boxProduct.quantity || boxProduct.quantity <= 0) {
      throw new BadRequestException(`El producto ${input.boxProductId} no tiene definidas las piezas por caja`);
    }

    const looseUnits = looseUnitsFromBoxes(input.boxQuantity, boxProduct.quantity);
    const reason = input.reason ?? `Break bulk: ${input.boxQuantity} box(es) -> ${looseUnits} loose units`;
    const { outResult, inResult, unitCost } = await this.prisma.$transaction((tx) =>
      this.openBoxes(tx, { ...input, looseProductId: link.looseProductId, looseUnits, reason }),
    );

    if (input.syncToSquare) {
      outResult.squareSync = await this.adjustments.syncCommitted(outResult.adjustment.id);
      inResult.squareSync = await this.adjustments.syncCommitted(inResult.adjustment.id);
    }

    this.logger.log(
      `[BREAK_BULK] Broke ${input.boxQuantity} box(es) of ${input.boxProductId} into ${looseUnits} loose units of ${link.looseProductId} at $${unitCost.toFixed(4)}/unit`,
    );

    return {
      boxAdjustment: outResult,
      looseAdjustment: inResult,
      looseUnitsCreated: looseUnits,
      costPerLooseUnit: unitCost,
    };
  }

  /**
   * Open just enough boxes for a sale that needs `needed` pieces of a suelto:
   * the pieces it doesn't already have, from the box linked to it at this store whose stock expires
   * soonest (no caducidad last, then oldest received, then id), up to what the
   * store has. Counted under the suelto's stock lock, so two covers take turns
   * and the second sees the first's sueltos. Opens nothing, without refusing,
   * when no box is needed or none has stock. `requestKey` makes a replay
   * return the first opening.
   */
  async coverLoose(input: CoverLooseInput): Promise<CoverLooseResult> {
    const key = `auto-open:${input.requestKey}`;
    const { locationId, looseProductId } = input;
    const result = await this.prisma.$transaction(async (tx): Promise<CoverLooseResult & { ids?: [string, string] }> => {
      const replayed = await tx.inventoryAdjustment.findUnique({ where: { clientRequestId: `${key}:out` } });
      if (replayed) {
        // From the pieces leg, not the box's pieces per box, which may have been edited since.
        const pieces = await tx.inventoryAdjustment.findUniqueOrThrow({ where: { clientRequestId: `${key}:in` } });
        return { boxesOpened: -replayed.quantity, boxProductId: replayed.productId, looseUnitsCreated: pieces.quantity, costPerLooseUnit: Number(pieces.unitCost) };
      }

      const short = input.needed - (await this.adjustments.lockedStock(tx, looseProductId, locationId));
      if (short <= 0) return { boxesOpened: 0 };

      const [box] = await tx.$queryRaw<Array<{ id: string; pieces: number; stock: number }>>`
        SELECT p.id, p.quantity AS pieces, SUM(i.quantity)::int AS stock
        FROM "Product" p
        JOIN "ProductLooseLink" k ON k."boxProductId" = p.id AND k."locationId" = ${locationId}
        JOIN "Inventory" i ON i."productId" = p.id
        WHERE k."looseProductId" = ${looseProductId} AND p.quantity > 0
          AND i."locationId" = ${locationId} AND i.quantity > 0
        GROUP BY p.id, p.quantity
        ORDER BY MIN(i."expiryDate") ASC NULLS LAST, MIN(i."receivedAt") ASC, p.id ASC
        LIMIT 1`;
      if (!box) return { boxesOpened: 0 };
      // The pick isn't locked: a manual Abrir caja draining this box before the OUT leg makes
      // createAdjustment refuse, and the sale job retries. That's intended; don't lock here.

      const boxQuantity = Math.min(Math.ceil(short / box.pieces), box.stock);
      const looseUnits = looseUnitsFromBoxes(boxQuantity, box.pieces);
      const { outResult, inResult, unitCost } = await this.openBoxes(tx, {
        boxProductId: box.id,
        locationId,
        looseProductId,
        boxQuantity,
        looseUnits,
        reason: 'Caja abierta automáticamente por una venta',
        notes: input.requestKey,
        adjustedBy: 'SYSTEM',
        clientRequestId: key,
      });
      return { boxesOpened: boxQuantity, boxProductId: box.id, looseUnitsCreated: looseUnits, costPerLooseUnit: unitCost, ids: [outResult.adjustment.id, inResult.adjustment.id] };
    });

    const { ids, ...cover } = result;
    if (ids && input.syncToSquare) for (const id of ids) await this.adjustments.syncCommitted(id);
    if (cover.boxesOpened) {
      this.logger.log(`[BREAK_BULK] Auto-opened ${cover.boxesOpened} box(es) of ${cover.boxProductId} for ${input.needed} pieces of ${looseProductId} (${input.requestKey})`);
    }
    return cover;
  }

  /**
   * The store's boxes opened by sales (coverLoose) and the shortfalls a sale
   * covered without a box, newest first, so a miscounted shelf or a missed
   * opening is caught. A cover is listed by the worker's label in its notes:
   * `squareId=<payment> · caja no abierta: <why>` (sale.worker.ts).
   */
  async automaticOpenings(locationId: string) {
    const rows = await this.prisma.inventoryAdjustment.findMany({
      where: {
        locationId,
        OR: [
          { type: 'BREAK_BULK_OUT', clientRequestId: { startsWith: 'auto-open:' } },
          { type: 'AUTO_SALE_COVER', notes: { contains: COVER_LABEL } },
        ],
      },
      include: { product: { select: { name: true } } },
      orderBy: { adjustedAt: 'desc' },
      take: 100,
    });
    return rows.map((a) =>
      a.type === 'BREAK_BULK_OUT'
        ? { kind: 'opened' as const, at: a.adjustedAt, productName: a.product.name, quantity: -a.quantity, paymentId: a.clientRequestId!.split(':')[1], why: undefined }
        : { kind: 'covered' as const, at: a.adjustedAt, productName: a.product.name, quantity: a.quantity, paymentId: /^squareId=(\S+)/.exec(a.notes!)?.[1], why: a.notes!.split(COVER_LABEL)[1] },
    );
  }

  /** Both legs of opening boxes, in the caller's transaction: boxes out at FIFO cost, pieces in at that cost and the soonest caducidad. */
  private async openBoxes(tx: Prisma.TransactionClient, input: OpenBoxesInput) {
    const { locationId, notes, adjustedBy, reason } = input;
    const requestKey = (leg: string) => (input.clientRequestId ? `${input.clientRequestId}:${leg}` : undefined);
    // Leg 1: consume boxes from this product's inventory (FIFO, weighted cost)
    const outResult = await this.adjustments.createAdjustment({
      locationId,
      productId: input.boxProductId,
      type: 'BREAK_BULK_OUT',
      quantity: -input.boxQuantity,
      reason,
      notes,
      adjustedBy,
      clientRequestId: requestKey('out'),
    }, tx);

    const unitCost = costPerLooseUnit(Number(outResult.adjustment.totalCost), input.looseUnits);
    // The loose units expire when the soonest box taken does.
    const { _min } = await tx.inventory.aggregate({
      where: { consumptions: { some: { adjustmentId: outResult.adjustment.id } } },
      _min: { expiryDate: true },
    });

    // Leg 2: create the loose units at the preserved cost basis
    const inResult = await this.adjustments.createAdjustment({
      locationId,
      productId: input.looseProductId,
      type: 'BREAK_BULK_IN',
      quantity: input.looseUnits,
      unitCost,
      expiryDate: _min.expiryDate ?? undefined,
      reason,
      notes,
      adjustedBy,
      clientRequestId: requestKey('in'),
    }, tx);
    return { outResult, inResult, unitCost };
  }
}

/** How the worker marks a sale's cover made without opening a box (sale.worker.ts). */
const COVER_LABEL = ' · caja no abierta: ';

export interface CoverLooseInput {
  locationId: string;
  looseProductId: string;
  /** Pieces the sale needs in all, not the shortfall: the shortfall is counted under the lock. */
  needed: number;
  /** Unique per sale and product (e.g. `<paymentId>:<productId>`); stored under an `auto-open:` prefix. */
  requestKey: string;
  syncToSquare?: boolean;
}

/** `boxesOpened: 0` (nothing needed, or no box with stock) comes with no other field. */
export interface CoverLooseResult {
  boxesOpened: number;
  boxProductId?: string;
  looseUnitsCreated?: number;
  costPerLooseUnit?: number;
}

type OpenBoxesInput = Pick<BreakBulkInput, 'boxProductId' | 'locationId' | 'boxQuantity' | 'notes' | 'adjustedBy'> & {
  looseProductId: string;
  looseUnits: number;
  reason: string;
  clientRequestId?: string;
};
