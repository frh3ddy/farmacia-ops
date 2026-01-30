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

        return {
          batchId: b.id,
          quantity: b.quantity,
          unitCost: b.unitCost.toString(),
          value: value.toString(),
          receivedAt: b.receivedAt,
          age: ageDays,
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

    // Group by type
    const byType = new Map<string, {
      type: string;
      count: number;
      totalQuantity: number;
      totalCost: Prisma.Decimal;
    }>();

    for (const adj of adjustments) {
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
    }

    // Calculate totals
    const totalLoss = adjustments
      .filter(a => a.quantity < 0)
      .reduce((sum, a) => sum.add(a.totalCost), new Prisma.Decimal(0));

    const totalGain = adjustments
      .filter(a => a.quantity > 0)
      .reduce((sum, a) => sum.add(a.totalCost), new Prisma.Decimal(0));

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

    for (const rec of receivings) {
      const key = rec.supplierId || 'none';
      const existing = bySupplier.get(key);
      if (existing) {
        existing.count++;
        existing.totalQuantity += rec.quantity;
        existing.totalCost = existing.totalCost.add(rec.totalCost);
      } else {
        bySupplier.set(key, {
          supplierId: rec.supplierId,
          supplierName: rec.supplier?.name || 'No Supplier',
          count: 1,
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
}
