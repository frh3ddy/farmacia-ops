import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { parseBusinessDate } from './business-date';

/** A lot as the app sends it: caducidad as a calendar day, lote (optional) as printed. */
export interface CountLotInput {
  quantity: number;
  expiryDate: string;
  batchNumber?: string;
}
type CountLot = { quantity: number; expiryDate: Date; lotNumber: string | null };

/**
 * The lots a count sends, checked: each a whole number of units with its caducidad
 * (the lote is optional; user, 2026-11-05), adding up to no more than the count (the rest stays without lot info).
 */
function parseLots(lots: unknown, countedQuantity: number): CountLot[] | undefined {
  if (lots == null || (Array.isArray(lots) && lots.length === 0)) return undefined;
  if (!Array.isArray(lots)) throw new BadRequestException('Los lotes deben ser una lista');
  const parsed = lots.map((lot: CountLotInput): CountLot => {
    const lotNumber = typeof lot?.batchNumber === 'string' && lot.batchNumber.trim() ? lot.batchNumber.trim().slice(0, 100) : null;
    const expiryDate = typeof lot?.expiryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(lot.expiryDate) ? parseBusinessDate(lot.expiryDate) : null;
    if (!Number.isInteger(lot?.quantity) || lot.quantity <= 0) throw new BadRequestException('Cada lote debe tener una cantidad entera mayor que cero');
    if (!expiryDate || isNaN(expiryDate.getTime())) throw new BadRequestException('Cada lote necesita su caducidad como fecha AAAA-MM-DD');
    return { quantity: lot.quantity, expiryDate, lotNumber };
  });
  const total = parsed.reduce((sum, l) => sum + l.quantity, 0);
  if (total > countedQuantity) {
    throw new BadRequestException({
      success: false,
      code: 'LOTS_TOTAL_MISMATCH',
      message: `Los lotes suman ${total}, más que las ${countedQuantity} unidades contadas`,
    });
  }
  return parsed;
}

interface RecordCountInput {
  locationId: string;
  productId: string;
  countedQuantity: number;
  unitCost?: number; // An increase on a product with no cost on record
  countedBy?: string;
  clientRequestId?: string; // The app's dedup key: a retry after commit returns the first result
  onlyIfUncounted?: boolean; // "Poner en 0": skip a product counted since the list was loaded
  lots?: unknown; // CountLotInput[] from the app: replace the product's lots at the store
}

/** A product someone counted after the No contados list was loaded. */
class AlreadyCountedError extends Error {
  constructor() {
    super('Ya se contó en este conteo');
  }
}

/**
 * Conteo inicial (tasks/opening-count-epic.md): a store-wide recount of the stock
 * the migration loaded. While a count is open, each product counted at the store
 * becomes an OPENING_COUNT adjustment (left out of shrinkage and the P&L) plus an
 * entry, so the products nobody counted can be listed and set to 0.
 */
@Injectable()
export class StockCountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adjustments: InventoryAdjustmentService,
  ) {}

  async start(locationId: string, startedBy: string) {
    try {
      return await this.prisma.stockCount.create({
        data: { locationId, openLocationId: locationId, startedBy },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Ya hay un conteo inicial abierto en esta sucursal');
      }
      throw error;
    }
  }

  /** The store's open count with how many products it has counted, or null. */
  async active(locationId: string) {
    const count = await this.prisma.stockCount.findUnique({
      where: { openLocationId: locationId },
      include: { _count: { select: { entries: true } } },
    });
    if (!count) return null;
    const { _count, openLocationId: _open, ...rest } = count;
    return { ...rest, countedProducts: _count.entries };
  }

  async end(id: string, locationId: string, endedBy: string) {
    const { count } = await this.prisma.stockCount.updateMany({
      where: { id, openLocationId: locationId },
      data: { openLocationId: null, endedAt: new Date(), endedBy },
    });
    if (count === 0) throw new NotFoundException('No hay un conteo inicial abierto con ese id en esta sucursal');
  }

  /**
   * The counted total replaces the stock, as a Corrección de Conteo would, but as a
   * Conteo inicial. A count equal to the stock saves the entry alone; a replay
   * after the first copy applied is one of those, so it keeps the first's
   * adjustment and the stock it replaced.
   */
  async recordCount(id: string, input: RecordCountInput) {
    const { locationId, productId, countedQuantity, countedBy, clientRequestId } = input;
    if (!Number.isInteger(countedQuantity) || countedQuantity < 0) {
      throw new BadRequestException('El conteo debe ser un número entero de cero o más');
    }
    const lots = parseLots(input.lots, countedQuantity);
    // A retry of a count that committed: re-applying the total would undo any sale since.
    if (clientRequestId) {
      const replayed = await this.replay(id, input);
      if (replayed) return replayed;
    }

    let committed;
    try {
      committed = await this.prisma.$transaction(async (tx) => {
        const open = await tx.stockCount.findFirst({
          where: { id, openLocationId: locationId },
        });
        if (!open) throw new BadRequestException('El conteo inicial ya terminó');

        const key = { stockCountId_productId: { stockCountId: id, productId } };
        if (input.onlyIfUncounted && (await tx.stockCountEntry.findUnique({ where: key }))) {
          throw new AlreadyCountedError();
        }

        const previousQuantity = await this.adjustments.lockedStock(tx, productId, locationId);
        const change = countedQuantity - previousQuantity;
        const adjustment =
          change === 0
            ? null
            : await this.adjustments.createAdjustment(
                {
                  locationId,
                  productId,
                  type: 'OPENING_COUNT',
                  quantity: change,
                  unitCost: input.unitCost,
                  adjustedBy: countedBy,
                },
                tx,
              );

        if (lots) await this.replaceLots(tx, productId, locationId, lots);

        const counted = {
          countedQuantity,
          countedBy,
          countedAt: new Date(),
          clientRequestId,
        };
        const entry = await tx.stockCountEntry.upsert({
          where: key,
          create: {
            stockCountId: id,
            productId,
            previousQuantity,
            adjustmentId: adjustment?.adjustment.id,
            ...counted,
          },
          update: adjustment
            ? {
                previousQuantity,
                adjustmentId: adjustment.adjustment.id,
                ...counted,
              }
            : counted,
        });
        return { entry, adjustment };
      });
    } catch (error) {
      // Two copies of the same retry raced past the lookup; the loser hit the unique key.
      if (clientRequestId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replayed = await this.replay(id, input);
        if (replayed) return replayed;
      }
      throw error;
    }
    const { entry, adjustment } = committed;

    // Inside the transaction createAdjustment left Square for after the commit.
    const squareSync = adjustment ? await this.adjustments.syncCommitted(adjustment.adjustment.id) : undefined;
    return {
      entry,
      adjustment: adjustment?.adjustment ?? null,
      inventoryImpact: adjustment?.inventoryImpact ?? null,
      squareSync,
    };
  }

  /** The first result of a request already applied, or null; a key reused for anything else is refused. */
  private async replay(id: string, input: RecordCountInput) {
    const entry = await this.prisma.stockCountEntry.findUnique({ where: { clientRequestId: input.clientRequestId } });
    if (!entry) return null;
    if (entry.stockCountId !== id || entry.productId !== input.productId || entry.countedQuantity !== input.countedQuantity) {
      throw new ConflictException('Este clientRequestId ya se usó para otro conteo');
    }
    return { entry, adjustment: null, inventoryImpact: null, squareSync: undefined };
  }

  /**
   * The product's stock at the store becomes exactly these lots, soonest caducidad
   * on the oldest units, so FIFO sells it first; units past the lots keep no lot.
   * A batch spanning lots is split: each piece keeps its cost, a millisecond later
   * than the one before so FIFO order holds, and the batch records what it gave
   * away (`splitOut`) for the books check. Runs under recordCount's lock.
   */
  private async replaceLots(tx: Prisma.TransactionClient, productId: string, locationId: string, lots: CountLot[]) {
    const queue = [...lots]
      .sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime())
      .map((lot) => ({ ...lot, left: lot.quantity }));
    const batches = await tx.inventory.findMany({
      where: { productId, locationId, quantity: { gt: 0 } },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });

    for (const batch of batches) {
      const pieces: Array<{ quantity: number; expiryDate: Date | null; lotNumber: string | null }> = [];
      for (let left = batch.quantity; left > 0; ) {
        const lot = queue.find((l) => l.left > 0);
        const quantity = lot ? Math.min(left, lot.left) : left;
        if (lot) lot.left -= quantity;
        pieces.push({ quantity, expiryDate: lot?.expiryDate ?? null, lotNumber: lot?.lotNumber ?? null });
        left -= quantity;
      }
      const [first, ...rest] = pieces;
      await tx.inventory.update({
        where: { id: batch.id },
        data: { ...first, splitOut: { increment: batch.quantity - first.quantity } },
      });
      for (const [i, piece] of rest.entries()) {
        await tx.inventory.create({
          data: {
            ...piece,
            productId,
            locationId,
            unitCost: batch.unitCost,
            receivedAt: new Date(batch.receivedAt.getTime() + i + 1),
            source: batch.source,
            costSource: batch.costSource,
            migrationId: batch.migrationId,
          },
        });
      }
    }
  }

  /** The product's count in this session at this store, or null: the form's "Ya contado" line. */
  async entry(id: string, locationId: string, productId: string) {
    const entry = await this.prisma.stockCountEntry.findFirst({
      where: { stockCountId: id, productId, stockCount: { locationId } },
      select: { countedQuantity: true, countedAt: true, countedBy: true },
    });
    if (!entry) return null;
    const employee = entry.countedBy
      ? await this.prisma.employee.findUnique({ where: { id: entry.countedBy }, select: { name: true } })
      : null;
    return { countedQuantity: entry.countedQuantity, countedAt: entry.countedAt, countedByName: employee?.name ?? null };
  }

  /**
   * The product's units at the store by lot, for the count form to pre-fill:
   * same caducidad day and lote merged, stock with no lot info left out,
   * soonest caducidad first and none last.
   */
  async lots(productId: string, locationId: string) {
    return this.prisma.$queryRaw<Array<{ quantity: number; expiryDate: string | null; batchNumber: string | null }>>`
      SELECT SUM(quantity)::int AS quantity, to_char("expiryDate", 'YYYY-MM-DD') AS "expiryDate", "lotNumber" AS "batchNumber"
      FROM "Inventory"
      WHERE "productId" = ${productId} AND "locationId" = ${locationId} AND quantity > 0
        AND ("expiryDate" IS NOT NULL OR "lotNumber" IS NOT NULL)
      GROUP BY 2, 3
      ORDER BY 2 ASC NULLS LAST, 3 ASC NULLS FIRST`;
  }

  /** Products with stock at the store that this count hasn't reached, largest value at cost first. */
  async uncounted(id: string, locationId: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        productId: string;
        name: string;
        units: number;
        value: Prisma.Decimal;
      }>
    >`
      SELECT i."productId", p.name, SUM(i.quantity)::int AS units, SUM(i.quantity * i."unitCost") AS value
      FROM "Inventory" i
      JOIN "Product" p ON p.id = i."productId"
      WHERE i."locationId" = ${locationId} AND i.quantity > 0
        AND NOT EXISTS (
          SELECT 1 FROM "StockCountEntry" e WHERE e."stockCountId" = ${id} AND e."productId" = i."productId"
        )
      GROUP BY i."productId", p.name
      ORDER BY value DESC, p.name`;
    return rows.map((r) => ({
      ...r,
      value: new Prisma.Decimal(r.value).toString(),
    }));
  }

  /** Each product counted as 0, one at a time, so one failure doesn't stop the rest. */
  async zero(id: string, locationId: string, productIds: string[], countedBy: string) {
    // Each product is a transaction plus a Square call: a store's whole list in one
    // request would outlast the app's 60 s timeout while the server kept zeroing.
    if (productIds.length > 100) throw new BadRequestException('Envía como máximo 100 productos por solicitud');
    const results: Array<{ productId: string; ok: boolean; code?: 'ALREADY_COUNTED'; error?: string }> = [];
    for (const productId of productIds) {
      try {
        await this.recordCount(id, {
          locationId,
          productId,
          countedQuantity: 0,
          countedBy,
          onlyIfUncounted: true,
        });
        results.push({ productId, ok: true });
      } catch (error) {
        results.push({
          productId,
          ok: false,
          // Stable for the app to show as skipped (it doesn't branch on message text).
          ...(error instanceof AlreadyCountedError && { code: 'ALREADY_COUNTED' as const }),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }
}
