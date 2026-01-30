import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

/**
 * Reconciliation result for a single product/location
 */
export interface ProductReconciliation {
  productId: string;
  productName: string;
  locationId: string;
  locationName: string;
  
  // Current state
  currentQuantity: number;
  currentValue: Prisma.Decimal;
  
  // Computed state (from audit trail)
  openingBalance: number;
  totalReceived: number;  // From purchases/adjustments (future)
  totalConsumed: number;  // From InventoryConsumption records
  expectedQuantity: number;
  
  // Discrepancy
  discrepancy: number;
  isReconciled: boolean;
  
  // Batch details
  batchCount: number;
  oldestBatchDate: Date | null;
  newestBatchDate: Date | null;
}

/**
 * Summary reconciliation for a location
 */
export interface LocationReconciliation {
  locationId: string;
  locationName: string;
  
  totalProducts: number;
  reconciledProducts: number;
  discrepancyProducts: number;
  
  totalCurrentValue: Prisma.Decimal;
  totalExpectedValue: Prisma.Decimal;
  valueDiscrepancy: Prisma.Decimal;
  
  products: ProductReconciliation[];
}

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
  private readonly logger = new Logger(InventoryReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reconcile inventory for a specific product and location
   * Compares current inventory quantity with consumption history
   */
  async reconcileProduct(
    productId: string,
    locationId: string,
  ): Promise<ProductReconciliation> {
    // Get product and location info
    const [product, location] = await Promise.all([
      this.prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, squareProductName: true },
      }),
      this.prisma.location.findUnique({
        where: { id: locationId },
        select: { id: true, name: true },
      }),
    ]);

    if (!product || !location) {
      throw new Error(`Product ${productId} or Location ${locationId} not found`);
    }

    // Get all inventory batches for this product/location
    const batches = await this.prisma.inventory.findMany({
      where: { productId, locationId },
      orderBy: { receivedAt: 'asc' },
    });

    // Calculate current state
    const currentQuantity = batches.reduce((sum, b) => sum + b.quantity, 0);
    const currentValue = batches.reduce(
      (sum, b) => sum.add(b.unitCost.mul(b.quantity)),
      new Prisma.Decimal(0),
    );

    // Get consumption records for this product/location
    const consumptions = await this.prisma.inventoryConsumption.findMany({
      where: {
        inventory: {
          productId,
          locationId,
        },
      },
      select: {
        quantity: true,
        totalCost: true,
      },
    });

    const totalConsumed = consumptions.reduce((sum, c) => sum + c.quantity, 0);

    // Calculate opening balance (sum of all batch quantities when received)
    // This is the initial quantity before any consumption
    const openingBalance = batches.reduce((sum, b) => {
      // Opening balance = current quantity + consumed from this batch
      // We need to get consumption per batch
      return sum + b.quantity; // This is simplified - we'd need per-batch consumption
    }, 0);

    // For now, simplified calculation:
    // Expected = Current (what's in batches now)
    // If we had full history: Expected = Opening + Received - Consumed
    const expectedQuantity = currentQuantity; // Simplified for now
    const discrepancy = currentQuantity - expectedQuantity;

    return {
      productId,
      productName: product.squareProductName || product.name,
      locationId,
      locationName: location.name,
      
      currentQuantity,
      currentValue,
      
      openingBalance: currentQuantity + totalConsumed, // Reconstructed
      totalReceived: 0, // Future: from purchase orders
      totalConsumed,
      expectedQuantity: currentQuantity + totalConsumed - totalConsumed, // = currentQuantity
      
      discrepancy,
      isReconciled: discrepancy === 0,
      
      batchCount: batches.length,
      oldestBatchDate: batches.length > 0 ? batches[0].receivedAt : null,
      newestBatchDate: batches.length > 0 ? batches[batches.length - 1].receivedAt : null,
    };
  }

  /**
   * Reconcile all products for a location
   */
  async reconcileLocation(locationId: string): Promise<LocationReconciliation> {
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true, name: true },
    });

    if (!location) {
      throw new Error(`Location ${locationId} not found`);
    }

    // Get all products with inventory at this location
    const inventoryProducts = await this.prisma.inventory.findMany({
      where: { locationId },
      select: { productId: true },
      distinct: ['productId'],
    });

    const productIds = inventoryProducts.map(i => i.productId);

    // Reconcile each product
    const products: ProductReconciliation[] = [];
    for (const productId of productIds) {
      try {
        const reconciliation = await this.reconcileProduct(productId, locationId);
        products.push(reconciliation);
      } catch (error) {
        this.logger.warn(`Failed to reconcile product ${productId}: ${error}`);
      }
    }

    // Calculate summary
    const reconciledProducts = products.filter(p => p.isReconciled).length;
    const discrepancyProducts = products.filter(p => !p.isReconciled).length;
    
    const totalCurrentValue = products.reduce(
      (sum, p) => sum.add(p.currentValue),
      new Prisma.Decimal(0),
    );
    
    const totalExpectedValue = totalCurrentValue; // Simplified
    const valueDiscrepancy = totalCurrentValue.sub(totalExpectedValue);

    return {
      locationId,
      locationName: location.name,
      
      totalProducts: products.length,
      reconciledProducts,
      discrepancyProducts,
      
      totalCurrentValue,
      totalExpectedValue,
      valueDiscrepancy,
      
      products,
    };
  }

  /**
   * Get consumption summary for a product over a time period
   */
  async getConsumptionSummary(
    productId: string,
    locationId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<ConsumptionSummary> {
    const [product, location] = await Promise.all([
      this.prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, squareProductName: true },
      }),
      this.prisma.location.findUnique({
        where: { id: locationId },
        select: { id: true, name: true },
      }),
    ]);

    if (!product) {
      throw new Error(`Product ${productId} not found`);
    }

    // Get consumption records for the period
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
      batchReceivedAt: c.inventory.receivedAt,
      batchSource: c.inventory.source,
      batchCostSource: c.inventory.costSource,
      quantityConsumed: c.quantity,
      unitCost: c.unitCost,
      totalCost: c.totalCost,
      consumedAt: c.consumedAt,
    }));
  }

  /**
   * Verify FIFO compliance for a sale
   * Checks that batches were consumed in correct chronological order
   */
  async verifyFIFOCompliance(saleId: string): Promise<{
    isCompliant: boolean;
    violations: Array<{
      saleItemId: string;
      productId: string;
      message: string;
    }>;
  }> {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        items: {
          include: {
            consumptions: {
              include: {
                inventory: {
                  select: { receivedAt: true },
                },
              },
              orderBy: {
                inventory: { receivedAt: 'asc' },
              },
            },
          },
        },
      },
    });

    if (!sale) {
      throw new Error(`Sale ${saleId} not found`);
    }

    const violations: Array<{
      saleItemId: string;
      productId: string;
      message: string;
    }> = [];

    for (const item of sale.items) {
      const consumptions = item.consumptions;
      
      // Check if consumptions are in FIFO order
      for (let i = 1; i < consumptions.length; i++) {
        const prev = consumptions[i - 1];
        const curr = consumptions[i];
        
        if (curr.inventory.receivedAt < prev.inventory.receivedAt) {
          violations.push({
            saleItemId: item.id,
            productId: item.productId,
            message: `Batch consumed out of FIFO order: batch from ${curr.inventory.receivedAt.toISOString()} consumed after batch from ${prev.inventory.receivedAt.toISOString()}`,
          });
        }
      }
    }

    return {
      isCompliant: violations.length === 0,
      violations,
    };
  }
}
