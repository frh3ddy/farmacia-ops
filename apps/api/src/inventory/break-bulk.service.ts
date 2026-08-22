import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
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
 * every other adjustment type, no new inventory-mutation logic here.
 *
 * ponytail: the two createAdjustment calls are not wrapped in one DB
 * transaction (createAdjustment owns its own) — matches this codebase's
 * existing TRANSFER_OUT/TRANSFER_IN pattern, which has the same gap. If the
 * second call fails after the first succeeds, the error is surfaced clearly
 * rather than silently swallowed so it can be reconciled manually.
 */
@Injectable()
export class BreakBulkService {
  private readonly logger = new Logger(BreakBulkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adjustments: InventoryAdjustmentService,
  ) {}

  async breakBulk(input: BreakBulkInput) {
    if (input.boxQuantity <= 0) {
      throw new BadRequestException('boxQuantity must be positive');
    }

    const boxProduct = await this.prisma.product.findUnique({ where: { id: input.boxProductId } });
    if (!boxProduct) {
      throw new NotFoundException(`Product ${input.boxProductId} not found`);
    }
    if (!boxProduct.looseProductId) {
      throw new BadRequestException(
        `Product ${input.boxProductId} has no linked loose product — set looseProductId first`,
      );
    }
    if (!boxProduct.quantity || boxProduct.quantity <= 0) {
      throw new BadRequestException(`Product ${input.boxProductId} has no quantity (base units per box) set`);
    }

    const looseUnits = looseUnitsFromBoxes(input.boxQuantity, boxProduct.quantity);
    const reason = input.reason ?? `Break bulk: ${input.boxQuantity} box(es) -> ${looseUnits} loose units`;

    // Leg 1: consume boxes from this product's inventory (FIFO, weighted cost)
    const outResult = await this.adjustments.createAdjustment({
      locationId: input.locationId,
      productId: input.boxProductId,
      type: 'BREAK_BULK_OUT',
      quantity: -input.boxQuantity,
      reason,
      notes: input.notes,
      syncToSquare: input.syncToSquare,
      adjustedBy: input.adjustedBy,
    });

    const unitCost = costPerLooseUnit(Number(outResult.adjustment.totalCost), looseUnits);

    // Leg 2: create the loose units at the preserved cost basis
    let inResult: Awaited<ReturnType<InventoryAdjustmentService['createAdjustment']>>;
    try {
      inResult = await this.adjustments.createAdjustment({
        locationId: input.locationId,
        productId: boxProduct.looseProductId,
        type: 'BREAK_BULK_IN',
        quantity: looseUnits,
        unitCost,
        reason,
        notes: input.notes,
        syncToSquare: input.syncToSquare,
        adjustedBy: input.adjustedBy,
      });
    } catch (error) {
      this.logger.error(
        `[BREAK_BULK] Consumed ${input.boxQuantity} box(es) of ${input.boxProductId} (adjustment ${outResult.adjustment.id}) but failed to create loose units on ${boxProduct.looseProductId} — reconcile manually. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    this.logger.log(
      `[BREAK_BULK] Broke ${input.boxQuantity} box(es) of ${input.boxProductId} into ${looseUnits} loose units of ${boxProduct.looseProductId} at $${unitCost.toFixed(4)}/unit`,
    );

    return {
      boxAdjustment: outResult,
      looseAdjustment: inResult,
      looseUnitsCreated: looseUnits,
      costPerLooseUnit: unitCost,
    };
  }
}
