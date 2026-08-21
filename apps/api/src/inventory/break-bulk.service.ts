import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { looseUnitsFromCajas, costPerLooseUnit } from './break-bulk';

export interface BreakBulkInput {
  cajaProductId: string;
  locationId: string;
  cajaQuantity: number;
  reason?: string;
  notes?: string;
  syncToSquare?: boolean;
  adjustedBy?: string;
}

/**
 * "Open a caja, add it as loose stock" — the caja and loose products are
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
    if (input.cajaQuantity <= 0) {
      throw new BadRequestException('cajaQuantity must be positive');
    }

    const cajaProduct = await this.prisma.product.findUnique({ where: { id: input.cajaProductId } });
    if (!cajaProduct) {
      throw new NotFoundException(`Product ${input.cajaProductId} not found`);
    }
    if (!cajaProduct.sueltoProductId) {
      throw new BadRequestException(
        `Product ${input.cajaProductId} has no linked loose product — set sueltoProductId first`,
      );
    }
    if (!cajaProduct.cantidad || cajaProduct.cantidad <= 0) {
      throw new BadRequestException(`Product ${input.cajaProductId} has no cantidad (base units per caja) set`);
    }

    const looseUnits = looseUnitsFromCajas(input.cajaQuantity, cajaProduct.cantidad);
    const reason = input.reason ?? `Break bulk: ${input.cajaQuantity} caja(s) -> ${looseUnits} loose units`;

    // Leg 1: consume cajas from this product's inventory (FIFO, weighted cost)
    const outResult = await this.adjustments.createAdjustment({
      locationId: input.locationId,
      productId: input.cajaProductId,
      type: 'BREAK_BULK_OUT',
      quantity: -input.cajaQuantity,
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
        productId: cajaProduct.sueltoProductId,
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
        `[BREAK_BULK] Consumed ${input.cajaQuantity} caja(s) of ${input.cajaProductId} (adjustment ${outResult.adjustment.id}) but failed to create loose units on ${cajaProduct.sueltoProductId} — reconcile manually. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    this.logger.log(
      `[BREAK_BULK] Broke ${input.cajaQuantity} caja(s) of ${input.cajaProductId} into ${looseUnits} loose units of ${cajaProduct.sueltoProductId} at $${unitCost.toFixed(4)}/unit`,
    );

    return {
      cajaAdjustment: outResult,
      looseAdjustment: inResult,
      looseUnitsCreated: looseUnits,
      costPerLooseUnit: unitCost,
    };
  }
}
