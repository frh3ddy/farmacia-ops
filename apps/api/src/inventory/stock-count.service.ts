import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';

interface RecordCountInput {
  locationId: string;
  productId: string;
  countedQuantity: number;
  unitCost?: number; // An increase on a product with no cost on record
  countedBy?: string;
  clientRequestId?: string; // The app's dedup key: a retry after commit returns the first result
  onlyIfUncounted?: boolean; // "Poner en 0": skip a product counted since the list was loaded
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
