import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

/**
 * Consumption summary for reporting
 */
export interface ConsumptionSummary {
  productId: string;
  productName: string;
  locationId: string;
  
  periodStart: Date;
  periodEnd: Date;
  
  totalQuantityConsumed: number;
  totalCostConsumed: Prisma.Decimal;
  averageUnitCost: Prisma.Decimal;
  
  saleCount: number;
  batchesConsumed: number;
}

@Injectable()
export class InventoryReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get consumption summary for a product over a time period
   */
  async getConsumptionSummary(
    productId: string,
    locationId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<ConsumptionSummary> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true, squareProductName: true },
    });

    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    const consumptions = await this.prisma.inventoryConsumption.findMany({
      where: {
        inventory: {
          productId,
          locationId,
        },
        consumedAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        saleItem: {
          select: { saleId: true },
        },
      },
    });

    const totalQuantityConsumed = consumptions.reduce((sum, c) => sum + c.quantity, 0);
    const totalCostConsumed = consumptions.reduce(
      (sum, c) => sum.add(c.totalCost),
      new Prisma.Decimal(0),
    );

    const averageUnitCost = totalQuantityConsumed > 0
      ? totalCostConsumed.div(totalQuantityConsumed)
      : new Prisma.Decimal(0);

    // Count unique sales and batches
    const uniqueSales = new Set(consumptions.map(c => c.saleItem?.saleId).filter(Boolean));
    const uniqueBatches = new Set(consumptions.map(c => c.inventoryId));

    return {
      productId,
      productName: product.squareProductName || product.name,
      locationId,
      
      periodStart: startDate,
      periodEnd: endDate,
      
      totalQuantityConsumed,
      totalCostConsumed,
      averageUnitCost,
      
      saleCount: uniqueSales.size,
      batchesConsumed: uniqueBatches.size,
    };
  }

  /**
   * Get consumption history for a specific sale item
   * Useful for auditing COGS calculations
   */
  async getSaleItemConsumption(saleItemId: string) {
    const consumptions = await this.prisma.inventoryConsumption.findMany({
      where: { saleItemId },
      include: {
        inventory: {
          select: {
            id: true,
            locationId: true,
            receivedAt: true,
            source: true,
            costSource: true,
          },
        },
      },
      orderBy: {
        inventory: { receivedAt: 'asc' },
      },
    });

    return consumptions.map(c => ({
      consumptionId: c.id,
      inventoryBatchId: c.inventoryId,
      batchLocationId: c.inventory.locationId,
      batchReceivedAt: c.inventory.receivedAt,
      batchSource: c.inventory.source,
      batchCostSource: c.inventory.costSource,
      quantityConsumed: c.quantity,
      unitCost: c.unitCost,
      totalCost: c.totalCost,
      consumedAt: c.consumedAt,
    }));
  }
}
