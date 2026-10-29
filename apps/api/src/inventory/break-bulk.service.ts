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
    if (!boxProduct.looseProductId) {
      throw new BadRequestException(
        `El producto ${input.boxProductId} no tiene un producto suelto vinculado. Vincúlalo primero.`,
      );
    }
    if (!boxProduct.quantity || boxProduct.quantity <= 0) {
      throw new BadRequestException(`El producto ${input.boxProductId} no tiene definidas las piezas por caja`);
    }

    const looseUnits = looseUnitsFromBoxes(input.boxQuantity, boxProduct.quantity);
    const reason = input.reason ?? `Break bulk: ${input.boxQuantity} box(es) -> ${looseUnits} loose units`;

    const looseProductId = boxProduct.looseProductId;
    const { outResult, inResult, unitCost } = await this.prisma.$transaction(async (tx) => {
      // Leg 1: consume boxes from this product's inventory (FIFO, weighted cost)
      const outResult = await this.adjustments.createAdjustment({
        locationId: input.locationId,
        productId: input.boxProductId,
        type: 'BREAK_BULK_OUT',
        quantity: -input.boxQuantity,
        reason,
        notes: input.notes,
        adjustedBy: input.adjustedBy,
      }, tx);

      const unitCost = costPerLooseUnit(Number(outResult.adjustment.totalCost), looseUnits);

      // Leg 2: create the loose units at the preserved cost basis
      const inResult = await this.adjustments.createAdjustment({
        locationId: input.locationId,
        productId: looseProductId,
        type: 'BREAK_BULK_IN',
        quantity: looseUnits,
        unitCost,
        reason,
        notes: input.notes,
        adjustedBy: input.adjustedBy,
      }, tx);
      return { outResult, inResult, unitCost };
    });

    if (input.syncToSquare) {
      outResult.squareSync = await this.adjustments.retrySquareSync(outResult.adjustment.id);
      inResult.squareSync = await this.adjustments.retrySquareSync(inResult.adjustment.id);
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
