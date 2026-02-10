import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

// ============================================================================
// Types
// ============================================================================

interface DateRange {
  startDate?: Date;
  endDate?: Date;
}

interface COGSReport {
  period: DateRange;
  locationId?: string;
  summary: {
    totalCOGS: string;
    totalRevenue: string;
    grossProfit: string;
    grossMarginPercent: string;
    totalUnitsSold: number;
    totalSales: number;
  };
  byProduct: Array<{
    productId: string;
    productName: string;
    sku: string | null;
    unitsSold: number;
    totalCost: string;
    totalRevenue: string;
    grossProfit: string;
    marginPercent: string;
  }>;
  byCategory?: Array<{
    categoryId: string | null;
    categoryName: string;
    totalCost: string;
    totalRevenue: string;
    grossProfit: string;
  }>;
}

interface InventoryValuationReport {
  asOfDate: Date;
  locationId?: string;
  summary: {
    totalUnits: number;
    totalValue: string;
    totalProducts: number;
    averageCostPerUnit: string;
  };
  byProduct: Array<{
    productId: string;
    productName: string;
    sku: string | null;
    totalQuantity: number;
    totalValue: string;
    averageCost: string;
    batches: Array<{
      batchId: string;
      quantity: number;
      unitCost: string;
      value: string;
      receivedAt: Date;
      age: number; // days since received
    }>;
  }>;
  agingSummary: {
    under30Days: { units: number; value: string };
    days30to60: { units: number; value: string };
    days60to90: { units: number; value: string };
    over90Days: { units: number; value: string };
  };
}

interface ProfitMarginReport {
  period: DateRange;
  locationId?: string;
  overallMargin: string;
  byProduct: Array<{
    productId: string;
    productName: string;
    revenue: string;
    cost: string;
    profit: string;
    marginPercent: string;
    unitsSold: number;
  }>;
  trends: Array<{
    date: string;
    revenue: string;
    cost: string;
    profit: string;
    marginPercent: string;
  }>;
}

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class InventoryReportsService {
  private readonly logger = new Logger(InventoryReportsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------------------
  // COGS Report (Cost of Goods Sold)
  // --------------------------------------------------------------------------
  async getCOGSReport(options: {
    locationId?: string;
    startDate?: Date;
    endDate?: Date;
    groupByCategory?: boolean;
  }): Promise<COGSReport> {
    const { locationId, startDate, endDate, groupByCategory } = options;

    // Build where clause for sales
    const salesWhere: Prisma.SaleWhereInput = {
      ...(locationId && { locationId }),
      ...(startDate && { createdAt: { gte: startDate } }),
      ...(endDate && { createdAt: { lte: endDate } }),
    };

    // Get sales with items
    const sales = await this.prisma.sale.findMany({
      where: salesWhere,
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                categoryId: true,
                category: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    // Aggregate by product
    const productMap = new Map<string, {
      productId: string;
      productName: string;
      sku: string | null;
      categoryId: string | null;
      categoryName: string;
      unitsSold: number;
      totalCost: Prisma.Decimal;
      totalRevenue: Prisma.Decimal;
    }>();

    let totalCOGS = new Prisma.Decimal(0);
    let totalRevenue = new Prisma.Decimal(0);
    let totalUnitsSold = 0;

    for (const sale of sales) {
      for (const item of sale.items) {
        const key = item.productId;
        const existing = productMap.get(key);

        const itemRevenue = item.price.mul(item.quantity);
        const itemCost = item.cost;

        if (existing) {
          existing.unitsSold += item.quantity;
          existing.totalCost = existing.totalCost.add(itemCost);
          existing.totalRevenue = existing.totalRevenue.add(itemRevenue);
        } else {
          productMap.set(key, {
            productId: item.productId,
            productName: item.product.name,
            sku: item.product.sku,
            categoryId: item.product.categoryId,
            categoryName: item.product.category?.name || 'Uncategorized',
            unitsSold: item.quantity,
            totalCost: itemCost,
            totalRevenue: itemRevenue,
          });
        }

        totalCOGS = totalCOGS.add(itemCost);
        totalRevenue = totalRevenue.add(itemRevenue);
        totalUnitsSold += item.quantity;
      }
    }

    const grossProfit = totalRevenue.sub(totalCOGS);
    const grossMarginPercent = totalRevenue.gt(0)
      ? grossProfit.div(totalRevenue).mul(100)
      : new Prisma.Decimal(0);

    // Build by-product list
    const byProduct = Array.from(productMap.values())
      .map(p => {
        const profit = p.totalRevenue.sub(p.totalCost);
        const margin = p.totalRevenue.gt(0)
          ? profit.div(p.totalRevenue).mul(100)
          : new Prisma.Decimal(0);

        return {
          productId: p.productId,
          productName: p.productName,
          sku: p.sku,
          unitsSold: p.unitsSold,
          totalCost: p.totalCost.toString(),
          totalRevenue: p.totalRevenue.toString(),
          grossProfit: profit.toString(),
          marginPercent: margin.toFixed(2),
        };
      })
      .sort((a, b) => parseFloat(b.totalCost) - parseFloat(a.totalCost));

    // Build by-category if requested
    let byCategory: COGSReport['byCategory'];
    if (groupByCategory) {
      const categoryMap = new Map<string | null, {
        categoryId: string | null;
        categoryName: string;
        totalCost: Prisma.Decimal;
        totalRevenue: Prisma.Decimal;
      }>();

      for (const p of productMap.values()) {
        const existing = categoryMap.get(p.categoryId);
        if (existing) {
          existing.totalCost = existing.totalCost.add(p.totalCost);
          existing.totalRevenue = existing.totalRevenue.add(p.totalRevenue);
        } else {
          categoryMap.set(p.categoryId, {
            categoryId: p.categoryId,
            categoryName: p.categoryName,
            totalCost: p.totalCost,
            totalRevenue: p.totalRevenue,
          });
        }
      }

      byCategory = Array.from(categoryMap.values()).map(c => ({
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        totalCost: c.totalCost.toString(),
        totalRevenue: c.totalRevenue.toString(),
        grossProfit: c.totalRevenue.sub(c.totalCost).toString(),
      }));
    }

    return {
      period: { startDate, endDate },
      locationId,
      summary: {
        totalCOGS: totalCOGS.toString(),
        totalRevenue: totalRevenue.toString(),
        grossProfit: grossProfit.toString(),
        grossMarginPercent: grossMarginPercent.toFixed(2),
        totalUnitsSold,
        totalSales: sales.length,
      },
      byProduct,
      byCategory,
    };
  }

  // --------------------------------------------------------------------------
  // Inventory Valuation Report
  // --------------------------------------------------------------------------
  async getInventoryValuationReport(options: {
    locationId?: string;
    productId?: string;
  }): Promise<InventoryValuationReport> {
    const { locationId, productId } = options;
    const now = new Date();

    // Get all inventory batches with positive quantity
    // Include receiving metadata for batch-level detail (lot#, expiry, supplier)
    const inventoryBatches = await this.prisma.inventory.findMany({
      where: {
        quantity: { gt: 0 },
        ...(locationId && { locationId }),
        ...(productId && { productId }),
      },
      include: {
        product: {
          select: { id: true, name: true, sku: true },
        },
        createdByReceiving: {
          select: {
            batchNumber: true,
            expiryDate: true,
            manufacturingDate: true,
            invoiceNumber: true,
            supplier: {
              select: { id: true, name: true },
            },
          },
        },
      },
      orderBy: [{ productId: 'asc' }, { receivedAt: 'asc' }],
    });

    // Group by product
    const productMap = new Map<string, {
      productId: string;
      productName: string;
      sku: string | null;
      batches: typeof inventoryBatches;
    }>();

    for (const batch of inventoryBatches) {
      const existing = productMap.get(batch.productId);
      if (existing) {
        existing.batches.push(batch);
      } else {
        productMap.set(batch.productId, {
          productId: batch.productId,
          productName: batch.product.name,
          sku: batch.product.sku,
          batches: [batch],
        });
      }
    }

    // Calculate totals and aging
    let totalUnits = 0;
    let totalValue = new Prisma.Decimal(0);
    const agingSummary = {
      under30Days: { units: 0, value: new Prisma.Decimal(0) },
      days30to60: { units: 0, value: new Prisma.Decimal(0) },
      days60to90: { units: 0, value: new Prisma.Decimal(0) },
      over90Days: { units: 0, value: new Prisma.Decimal(0) },
    };

    const byProduct = Array.from(productMap.values()).map(p => {
      let productQuantity = 0;
      let productValue = new Prisma.Decimal(0);

      const batches = p.batches.map(b => {
        const value = b.unitCost.mul(b.quantity);
        const ageMs = now.getTime() - b.receivedAt.getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

        productQuantity += b.quantity;
        productValue = productValue.add(value);
        totalUnits += b.quantity;
        totalValue = totalValue.add(value);

        // Aging buckets
        if (ageDays < 30) {
          agingSummary.under30Days.units += b.quantity;
          agingSummary.under30Days.value = agingSummary.under30Days.value.add(value);
        } else if (ageDays < 60) {
          agingSummary.days30to60.units += b.quantity;
          agingSummary.days30to60.value = agingSummary.days30to60.value.add(value);
        } else if (ageDays < 90) {
          agingSummary.days60to90.units += b.quantity;
          agingSummary.days60to90.value = agingSummary.days60to90.value.add(value);
        } else {
          agingSummary.over90Days.units += b.quantity;
          agingSummary.over90Days.value = agingSummary.over90Days.value.add(value);
        }

        // Pull batch-level metadata from the linked receiving record
        const receiving = b.createdByReceiving;

        return {
          batchId: b.id,
          quantity: b.quantity,
          unitCost: b.unitCost.toString(),
          value: value.toString(),
          receivedAt: b.receivedAt,
          age: ageDays,
          source: b.source ?? null,           // "PURCHASE", "OPENING_BALANCE", "ADJUSTMENT"
          batchNumber: receiving?.batchNumber ?? null,
          expiryDate: receiving?.expiryDate ?? null,
          manufacturingDate: receiving?.manufacturingDate ?? null,
          invoiceNumber: receiving?.invoiceNumber ?? null,
          supplierId: receiving?.supplier?.id ?? null,
          supplierName: receiving?.supplier?.name ?? null,
        };
      });

      const avgCost = productQuantity > 0
        ? productValue.div(productQuantity)
        : new Prisma.Decimal(0);

      return {
        productId: p.productId,
        productName: p.productName,
        sku: p.sku,
        totalQuantity: productQuantity,
        totalValue: productValue.toString(),
        averageCost: avgCost.toFixed(2),
        batches,
      };
    });

    const avgCostPerUnit = totalUnits > 0
      ? totalValue.div(totalUnits)
      : new Prisma.Decimal(0);

    return {
      asOfDate: now,
      locationId,
      summary: {
        totalUnits,
        totalValue: totalValue.toString(),
        totalProducts: productMap.size,
        averageCostPerUnit: avgCostPerUnit.toFixed(2),
      },
      byProduct,
      agingSummary: {
        under30Days: {
          units: agingSummary.under30Days.units,
          value: agingSummary.under30Days.value.toString(),
        },
        days30to60: {
          units: agingSummary.days30to60.units,
          value: agingSummary.days30to60.value.toString(),
        },
        days60to90: {
          units: agingSummary.days60to90.units,
          value: agingSummary.days60to90.value.toString(),
        },
        over90Days: {
          units: agingSummary.over90Days.units,
          value: agingSummary.over90Days.value.toString(),
        },
      },
    };
  }

  // --------------------------------------------------------------------------
  // Profit Margin Report with Trends
  // --------------------------------------------------------------------------
  async getProfitMarginReport(options: {
    locationId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<ProfitMarginReport> {
    const { locationId, startDate, endDate } = options;

    const salesWhere: Prisma.SaleWhereInput = {
      ...(locationId && { locationId }),
      ...(startDate && { createdAt: { gte: startDate } }),
      ...(endDate && { createdAt: { lte: endDate } }),
    };

    // Get sales aggregated
    const sales = await this.prisma.sale.findMany({
      where: salesWhere,
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Calculate overall and by product
    let totalRevenue = new Prisma.Decimal(0);
    let totalCost = new Prisma.Decimal(0);
    const productMap = new Map<string, {
      productId: string;
      productName: string;
      revenue: Prisma.Decimal;
      cost: Prisma.Decimal;
      unitsSold: number;
    }>();

    // Daily trends
    const dailyMap = new Map<string, {
      revenue: Prisma.Decimal;
      cost: Prisma.Decimal;
    }>();

    for (const sale of sales) {
      const dateKey = sale.createdAt.toISOString().split('T')[0];

      for (const item of sale.items) {
        const revenue = item.price.mul(item.quantity);
        const cost = item.cost;

        totalRevenue = totalRevenue.add(revenue);
        totalCost = totalCost.add(cost);

        // By product
        const existing = productMap.get(item.productId);
        if (existing) {
          existing.revenue = existing.revenue.add(revenue);
          existing.cost = existing.cost.add(cost);
          existing.unitsSold += item.quantity;
        } else {
          productMap.set(item.productId, {
            productId: item.productId,
            productName: item.product.name,
            revenue,
            cost,
            unitsSold: item.quantity,
          });
        }

        // Daily
        const dailyExisting = dailyMap.get(dateKey);
        if (dailyExisting) {
          dailyExisting.revenue = dailyExisting.revenue.add(revenue);
          dailyExisting.cost = dailyExisting.cost.add(cost);
        } else {
          dailyMap.set(dateKey, { revenue, cost });
        }
      }
    }

    const totalProfit = totalRevenue.sub(totalCost);
    const overallMargin = totalRevenue.gt(0)
      ? totalProfit.div(totalRevenue).mul(100).toFixed(2)
      : '0.00';

    const byProduct = Array.from(productMap.values())
      .map(p => {
        const profit = p.revenue.sub(p.cost);
        const margin = p.revenue.gt(0)
          ? profit.div(p.revenue).mul(100).toFixed(2)
          : '0.00';

        return {
          productId: p.productId,
          productName: p.productName,
          revenue: p.revenue.toString(),
          cost: p.cost.toString(),
          profit: profit.toString(),
          marginPercent: margin,
          unitsSold: p.unitsSold,
        };
      })
      .sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));

    const trends = Array.from(dailyMap.entries())
      .map(([date, data]) => {
        const profit = data.revenue.sub(data.cost);
        const margin = data.revenue.gt(0)
          ? profit.div(data.revenue).mul(100).toFixed(2)
          : '0.00';

        return {
          date,
          revenue: data.revenue.toString(),
          cost: data.cost.toString(),
          profit: profit.toString(),
          marginPercent: margin,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      period: { startDate, endDate },
      locationId,
      overallMargin,
      byProduct,
      trends,
    };
  }

  // --------------------------------------------------------------------------
  // Adjustment Impact Report
  // --------------------------------------------------------------------------
  async getAdjustmentImpactReport(options: {
    locationId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { locationId, startDate, endDate } = options;

    this.logger.log(`[ADJUSTMENT_REPORT] Fetching adjustments - locationId: ${locationId}, startDate: ${startDate?.toISOString()}, endDate: ${endDate?.toISOString()}`);

    const adjustments = await this.prisma.inventoryAdjustment.findMany({
      where: {
        ...(locationId && { locationId }),
        ...(startDate && { adjustedAt: { gte: startDate } }),
        ...(endDate && { adjustedAt: { lte: endDate } }),
      },
      include: {
        product: { select: { id: true, name: true } },
      },
    });

    this.logger.log(`[ADJUSTMENT_REPORT] Found ${adjustments.length} adjustments`);

    // Group by type
    const byType = new Map<string, {
      type: string;
      count: number;
      totalQuantity: number;
      totalCost: Prisma.Decimal;
    }>();

    // Group by product
    const byProduct = new Map<string, {
      productId: string;
      productName: string;
      adjustmentCount: number;
      totalQuantity: number;
      totalLoss: Prisma.Decimal;
      totalGain: Prisma.Decimal;
    }>();

    for (const adj of adjustments) {
      // By type aggregation
      const existing = byType.get(adj.type);
      if (existing) {
        existing.count++;
        existing.totalQuantity += Math.abs(adj.quantity);
        existing.totalCost = existing.totalCost.add(adj.totalCost);
      } else {
        byType.set(adj.type, {
          type: adj.type,
          count: 1,
          totalQuantity: Math.abs(adj.quantity),
          totalCost: adj.totalCost,
        });
      }

      // By product aggregation
      const productEntry = byProduct.get(adj.productId);
      if (productEntry) {
        productEntry.adjustmentCount++;
        productEntry.totalQuantity += Math.abs(adj.quantity);
        if (adj.quantity < 0) {
          productEntry.totalLoss = productEntry.totalLoss.add(adj.totalCost);
        } else {
          productEntry.totalGain = productEntry.totalGain.add(adj.totalCost);
        }
      } else {
        byProduct.set(adj.productId, {
          productId: adj.productId,
          productName: adj.product?.name || 'Unknown Product',
          adjustmentCount: 1,
          totalQuantity: Math.abs(adj.quantity),
          totalLoss: adj.quantity < 0 ? adj.totalCost : new Prisma.Decimal(0),
          totalGain: adj.quantity > 0 ? adj.totalCost : new Prisma.Decimal(0),
        });
      }
    }

    // Calculate totals
    const totalLoss = adjustments
      .filter(a => a.quantity < 0)
      .reduce((sum, a) => sum.add(a.totalCost), new Prisma.Decimal(0));

    const totalGain = adjustments
      .filter(a => a.quantity > 0)
      .reduce((sum, a) => sum.add(a.totalCost), new Prisma.Decimal(0));

    this.logger.log(`[ADJUSTMENT_REPORT] Summary - totalAdjustments: ${adjustments.length}, totalLoss: ${totalLoss.toString()}, totalGain: ${totalGain.toString()}, netImpact: ${totalGain.sub(totalLoss).toString()}`);

    return {
      period: { startDate, endDate },
      locationId,
      summary: {
        totalAdjustments: adjustments.length,
        totalLoss: totalLoss.toString(),
        totalGain: totalGain.toString(),
        netImpact: totalGain.sub(totalLoss).toString(),
      },
      byType: Array.from(byType.values()).map(t => ({
        type: t.type,
        count: t.count,
        totalQuantity: t.totalQuantity,
        totalCost: t.totalCost.toString(),
      })),
      byProduct: Array.from(byProduct.values())
        .map(p => ({
          productId: p.productId,
          productName: p.productName,
          adjustmentCount: p.adjustmentCount,
          totalQuantity: p.totalQuantity,
          totalLoss: p.totalLoss.toString(),
          totalGain: p.totalGain.toString(),
          netImpact: p.totalGain.sub(p.totalLoss).toString(),
        }))
        .sort((a, b) => parseFloat(b.totalLoss) - parseFloat(a.totalLoss)),
    };
  }

  // --------------------------------------------------------------------------
  // Receiving Summary Report
  // --------------------------------------------------------------------------
  async getReceivingSummaryReport(options: {
    locationId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { locationId, startDate, endDate } = options;

    const receivings = await this.prisma.inventoryReceiving.findMany({
      where: {
        ...(locationId && { locationId }),
        ...(startDate && { receivedAt: { gte: startDate } }),
        ...(endDate && { receivedAt: { lte: endDate } }),
      },
      include: {
        supplier: { select: { id: true, name: true } },
        product: { select: { id: true, name: true } },
      },
    });

    // Group by supplier
    const bySupplier = new Map<string, {
      supplierId: string | null;
      supplierName: string;
      count: number;
      totalQuantity: number;
      totalCost: Prisma.Decimal;
    }>();

    // Group by product
    const byProduct = new Map<string, {
      productId: string;
      productName: string;
      receivingCount: number;
      totalQuantity: number;
      totalCost: Prisma.Decimal;
    }>();

    for (const rec of receivings) {
      // By supplier aggregation
      const supplierKey = rec.supplierId || 'none';
      const existingSupplier = bySupplier.get(supplierKey);
      if (existingSupplier) {
        existingSupplier.count++;
        existingSupplier.totalQuantity += rec.quantity;
        existingSupplier.totalCost = existingSupplier.totalCost.add(rec.totalCost);
      } else {
        bySupplier.set(supplierKey, {
          supplierId: rec.supplierId,
          supplierName: rec.supplier?.name || 'No Supplier',
          count: 1,
          totalQuantity: rec.quantity,
          totalCost: rec.totalCost,
        });
      }

      // By product aggregation
      const existingProduct = byProduct.get(rec.productId);
      if (existingProduct) {
        existingProduct.receivingCount++;
        existingProduct.totalQuantity += rec.quantity;
        existingProduct.totalCost = existingProduct.totalCost.add(rec.totalCost);
      } else {
        byProduct.set(rec.productId, {
          productId: rec.productId,
          productName: rec.product?.name || 'Unknown Product',
          receivingCount: 1,
          totalQuantity: rec.quantity,
          totalCost: rec.totalCost,
        });
      }
    }

    const totalCost = receivings.reduce(
      (sum, r) => sum.add(r.totalCost),
      new Prisma.Decimal(0)
    );
    const totalQuantity = receivings.reduce((sum, r) => sum + r.quantity, 0);

    return {
      period: { startDate, endDate },
      locationId,
      summary: {
        totalReceivings: receivings.length,
        totalQuantity,
        totalCost: totalCost.toString(),
        averageCostPerUnit: totalQuantity > 0
          ? totalCost.div(totalQuantity).toFixed(2)
          : '0.00',
      },
      bySupplier: Array.from(bySupplier.values()).map(s => ({
        supplierId: s.supplierId,
        supplierName: s.supplierName,
        receivingCount: s.count,
        totalQuantity: s.totalQuantity,
        totalCost: s.totalCost.toString(),
      })),
      byProduct: Array.from(byProduct.values())
        .map(p => ({
          productId: p.productId,
          productName: p.productName,
          receivingCount: p.receivingCount,
          totalQuantity: p.totalQuantity,
          totalCost: p.totalCost.toString(),
          averageCost: p.totalQuantity > 0
            ? p.totalCost.div(p.totalQuantity).toFixed(2)
            : '0.00',
        }))
        .sort((a, b) => parseFloat(b.totalCost) - parseFloat(a.totalCost)),
    };
  }

  // --------------------------------------------------------------------------
  // Profit & Loss Report (Income Statement)
  // Includes: Revenue, COGS, Gross Profit, Operating Expenses, Net Profit
  // --------------------------------------------------------------------------
  async getProfitAndLossReport(options: {
    locationId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { locationId, startDate, endDate } = options;

    // 1. Get Sales Revenue and COGS
    const salesWhere: Prisma.SaleWhereInput = {
      ...(locationId && { locationId }),
      ...(startDate && { createdAt: { gte: startDate } }),
      ...(endDate && { createdAt: { lte: endDate } }),
    };

    const salesAgg = await this.prisma.sale.aggregate({
      where: salesWhere,
      _sum: {
        totalRevenue: true,
        totalCost: true,
        grossProfit: true,
      },
      _count: { id: true },
    });

    const revenue = salesAgg._sum.totalRevenue || new Prisma.Decimal(0);
    const cogs = salesAgg._sum.totalCost || new Prisma.Decimal(0);
    const grossProfit = salesAgg._sum.grossProfit || new Prisma.Decimal(0);

    // 2. Get Operating Expenses
    const expenseWhere: Prisma.ExpenseWhereInput = {
      ...(locationId && { locationId }),
      ...(startDate && { date: { gte: startDate } }),
      ...(endDate && { date: { lte: endDate } }),
    };

    const expenses = await this.prisma.expense.findMany({ where: expenseWhere });

    // Group expenses by type
    const expensesByType = new Map<string, Prisma.Decimal>();
    let totalExpenses = new Prisma.Decimal(0);

    for (const expense of expenses) {
      totalExpenses = totalExpenses.add(expense.amount);
      const existing = expensesByType.get(expense.type) || new Prisma.Decimal(0);
      expensesByType.set(expense.type, existing.add(expense.amount));
    }

    // 3. Get Inventory Adjustment Losses (shrinkage)
    const adjustmentWhere: Prisma.InventoryAdjustmentWhereInput = {
      ...(locationId && { locationId }),
      ...(startDate && { adjustedAt: { gte: startDate } }),
      ...(endDate && { adjustedAt: { lte: endDate } }),
      quantity: { lt: 0 }, // Only losses
    };

    const adjustmentLosses = await this.prisma.inventoryAdjustment.aggregate({
      where: adjustmentWhere,
      _sum: { totalCost: true },
    });

    const shrinkage = adjustmentLosses._sum.totalCost || new Prisma.Decimal(0);

    // 4. Calculate Net Profit
    const operatingExpenses = totalExpenses.add(shrinkage);
    const netProfit = grossProfit.sub(operatingExpenses);

    // 5. Calculate margins
    const grossMarginPercent = revenue.gt(0)
      ? grossProfit.div(revenue).mul(100)
      : new Prisma.Decimal(0);

    const netMarginPercent = revenue.gt(0)
      ? netProfit.div(revenue).mul(100)
      : new Prisma.Decimal(0);

    // 6. Build expense breakdown
    const expenseBreakdown = Array.from(expensesByType.entries())
      .map(([type, amount]) => ({
        type,
        amount: amount.toString(),
        percentage: totalExpenses.gt(0)
          ? amount.div(totalExpenses).mul(100).toFixed(2)
          : '0.00',
      }))
      .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));

    return {
      period: { startDate, endDate },
      locationId,
      // Income Statement
      revenue: {
        sales: revenue.toString(),
        // Could add other income sources here
        total: revenue.toString(),
      },
      costOfGoodsSold: {
        productCosts: cogs.toString(),
        total: cogs.toString(),
      },
      grossProfit: {
        amount: grossProfit.toString(),
        marginPercent: grossMarginPercent.toFixed(2),
      },
      operatingExpenses: {
        byType: expenseBreakdown,
        shrinkage: shrinkage.toString(), // Inventory losses
        total: operatingExpenses.toString(),
      },
      netProfit: {
        amount: netProfit.toString(),
        marginPercent: netMarginPercent.toFixed(2),
      },
      // Summary metrics
      summary: {
        totalRevenue: revenue.toString(),
        totalCOGS: cogs.toString(),
        grossProfit: grossProfit.toString(),
        grossMarginPercent: grossMarginPercent.toFixed(2),
        totalOperatingExpenses: operatingExpenses.toString(),
        netProfit: netProfit.toString(),
        netMarginPercent: netMarginPercent.toFixed(2),
        salesCount: salesAgg._count.id,
        expenseCount: expenses.length,
      },
    };
  }

  // ============================================================================
  // Batch Detail - Full history for a single inventory batch
  // ============================================================================

  async getBatchDetail(batchId: string) {
    // Get the batch with all related data
    const batch = await this.prisma.inventory.findUnique({
      where: { id: batchId },
      include: {
        product: {
          select: { id: true, name: true, sku: true },
        },
        location: {
          select: { id: true, name: true },
        },
        // The receiving that created this batch
        createdByReceiving: {
          include: {
            supplier: {
              select: { id: true, name: true },
            },
          },
        },
        // The adjustment that created this batch (if any)
        createdByAdjustment: true,
        // All consumption records (FIFO audit trail)
        consumptions: {
          include: {
            saleItem: {
              include: {
                sale: {
                  select: { id: true, squareId: true, createdAt: true, totalRevenue: true },
                },
              },
            },
            adjustment: {
              select: {
                id: true,
                type: true,
                reason: true,
                notes: true,
                adjustedAt: true,
                adjustedBy: true,
              },
            },
          },
          orderBy: {
            consumedAt: 'asc' as const,
          },
        },
      },
    });

    if (!batch) {
      return null;
    }

    // Calculate derived data
    const now = new Date();
    const ageMs = now.getTime() - batch.receivedAt.getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const currentValue = batch.unitCost.mul(batch.quantity);
    const receiving = batch.createdByReceiving;
    const originalQuantity = receiving
      ? receiving.quantity
      : (batch.createdByAdjustment?.quantity ?? batch.quantity);
    const totalConsumed = batch.consumptions.reduce(
      (sum, c) => sum + c.quantity,
      0,
    );

    return {
      // Core batch data
      batchId: batch.id,
      productId: batch.productId,
      productName: batch.product.name,
      productSku: batch.product.sku,
      locationId: batch.locationId,
      locationName: batch.location.name,
      quantity: batch.quantity,
      unitCost: batch.unitCost.toString(),
      currentValue: currentValue.toString(),
      receivedAt: batch.receivedAt,
      ageDays,
      source: batch.source,

      // Original quantity tracking
      originalQuantity,
      totalConsumed,
      remainingPercent:
        originalQuantity > 0
          ? ((batch.quantity / originalQuantity) * 100).toFixed(1)
          : '100.0',

      // Receiving metadata (if created by receiving)
      receiving: receiving
        ? {
            id: receiving.id,
            batchNumber: receiving.batchNumber,
            expiryDate: receiving.expiryDate,
            manufacturingDate: receiving.manufacturingDate,
            invoiceNumber: receiving.invoiceNumber,
            supplierId: receiving.supplier?.id ?? null,
            supplierName: receiving.supplier?.name ?? null,
            receivedBy: receiving.receivedBy,
            notes: receiving.notes,
            receivedAt: receiving.receivedAt,
          }
        : null,

      // Adjustment metadata (if created by adjustment)
      adjustment: batch.createdByAdjustment
        ? {
            id: batch.createdByAdjustment.id,
            type: batch.createdByAdjustment.type,
            reason: batch.createdByAdjustment.reason,
            notes: batch.createdByAdjustment.notes,
            adjustedAt: batch.createdByAdjustment.adjustedAt,
            adjustedBy: batch.createdByAdjustment.adjustedBy,
          }
        : null,

      // Consumption history (FIFO audit trail)
      consumptions: batch.consumptions.map((c) => ({
        id: c.id,
        quantity: c.quantity,
        unitCost: c.unitCost.toString(),
        totalCost: c.totalCost.toString(),
        consumedAt: c.consumedAt,
        // What consumed it
        type: c.saleItemId ? 'SALE' : c.adjustmentId ? 'ADJUSTMENT' : 'UNKNOWN',
        sale: c.saleItem
          ? {
              saleId: c.saleItem.sale.id,
              squareId: c.saleItem.sale.squareId,
              saleDate: c.saleItem.sale.createdAt,
              itemQuantity: c.saleItem.quantity,
              itemPrice: c.saleItem.price.toString(),
            }
          : null,
        adjustment: c.adjustment
          ? {
              adjustmentId: c.adjustment.id,
              type: c.adjustment.type,
              reason: c.adjustment.reason,
              adjustedAt: c.adjustment.adjustedAt,
            }
          : null,
      })),

      // Timeline: ordered events from creation to current state
      consumptionCount: batch.consumptions.length,
    };
  }
}
