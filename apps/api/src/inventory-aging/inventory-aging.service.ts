import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

// Use Prisma's Decimal type
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/**
 * Aging bucket configuration
 */
export interface AgingBucket {
  label: string;
  min: number;
  max: number | typeof Infinity;
}

export interface AgingBucketConfig {
  buckets: AgingBucket[];
  categoryId?: string | null;
}

/**
 * Aged inventory batch with calculated age and bucket assignment
 */
export interface AgedInventoryBatch {
  batch: {
    id: string;
    locationId: string;
    productId: string;
    quantity: number;
    receivedAt: Date;
    unitCost: Decimal;
    product: {
      id: string;
      name: string;
      sku: string | null;
      categoryId: string | null;
      category: {
        id: string;
        name: string;
      } | null;
    };
    location: {
      id: string;
      name: string;
      squareId: string | null;
    };
  };
  ageDays: number;
  bucket: AgingBucket;
  cashValue: Decimal;
}

/**
 * Bucket summary with aggregated data
 */
export interface BucketSummary {
  bucket: AgingBucket;
  cashValue: Decimal;
  unitCount: number;
  percentageOfTotal: number;
}

/**
 * Overall aging summary
 */
export interface AgingSummary {
  buckets: BucketSummary[];
  totalCashTiedUp: Decimal;
  totalUnits: number;
}

/**
 * Product aging analysis
 */
export interface ProductAgingAnalysis {
  productId: string;
  productName: string;
  categoryName: string | null;
  totalCashTiedUp: Decimal;
  totalUnits: number;
  oldestBatchAge: number;
  bucketDistribution: BucketSummary[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

/**
 * Location aging analysis
 */
export interface LocationAgingAnalysis {
  locationId: string;
  locationName: string;
  totalCashTiedUp: Decimal;
  totalUnits: number;
  bucketDistribution: BucketSummary[];
  atRiskProducts: number;
}

/**
 * Category aging analysis
 */
export interface CategoryAgingAnalysis {
  categoryId: string;
  categoryName: string;
  totalCashTiedUp: Decimal;
  totalUnits: number;
  bucketDistribution: BucketSummary[];
  averageAge: number;
}

/**
 * Actionable signal for inventory management
 */
export interface ActionableSignal {
  type: 'AT_RISK' | 'SLOW_MOVING_EXPENSIVE' | 'OVERSTOCKED_CATEGORY';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  entityType: 'PRODUCT' | 'LOCATION' | 'CATEGORY';
  entityId: string;
  entityName: string;
  message: string;
  recommendedActions: string[];
  cashAtRisk: Decimal | null;
}

/**
 * Default aging buckets configuration
 */
const DEFAULT_AGING_BUCKETS: AgingBucketConfig = {
  buckets: [
    { label: '0–30', min: 0, max: 30 },
    { label: '31–60', min: 31, max: 60 },
    { label: '61–90', min: 61, max: 90 },
    { label: '90+', min: 91, max: Infinity },
  ],
  categoryId: null,
};

/**
 * Signal generation thresholds
 */
const SIGNAL_THRESHOLDS = {
  SLOW_MOVING_THRESHOLD: new Decimal(1000.0),
  CRITICAL_CASH_THRESHOLD: new Decimal(5000.0),
  OVERSTOCK_THRESHOLD: new Decimal(10000.0),
  CRITICAL_CATEGORY_THRESHOLD: new Decimal(50000.0),
};

/**
 * Cache entry for aged inventory data
 */
interface AgingCacheEntry {
  agedBatches: AgedInventoryBatch[];
  timestamp: number;
}

@Injectable()
export class InventoryAgingService {
  constructor(private readonly prisma: PrismaService) {}

  // In-memory cache for aging data (keyed by filter hash)
  private agingCache: Map<string, AgingCacheEntry> = new Map();
  
  // Cache TTL: 5 minutes (aging data doesn't change frequently)
  private readonly CACHE_TTL_MS = parseInt(
    process.env.AGING_CACHE_TTL_MS || '300000',
    10,
  );

  /**
   * Generate cache key from filters
   */
  private getCacheKey(locationId?: string, categoryId?: string): string {
    return `${locationId || 'all'}:${categoryId || 'all'}`;
  }

  /**
   * Check if cache entry is valid
   */
  private isCacheValid(entry: AgingCacheEntry): boolean {
    return Date.now() - entry.timestamp < this.CACHE_TTL_MS;
  }

  /**
   * Clear aging cache (call when inventory changes)
   */
  clearAgingCache(locationId?: string, categoryId?: string): void {
    if (locationId || categoryId) {
      // Clear specific cache entry
      const key = this.getCacheKey(locationId, categoryId);
      this.agingCache.delete(key);
      // Also clear the 'all' cache since it would include this data
      this.agingCache.delete(this.getCacheKey());
    } else {
      // Clear all cache entries
      this.agingCache.clear();
    }
  }

  /**
   * Calculate days since batch was received (authoritative age calculation)
   */
  calculateAge(receivedAt: Date): number {
    const now = Date.now();
    const received = receivedAt.getTime();
    const diffMs = now - received;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays); // Clamp to 0 if future date
  }

  /**
   * Get aging bucket configuration for a category (with fallback to default)
   */
  getAgingBucketsForCategory(categoryId: string | null): AgingBucketConfig {
    // For now, always return default buckets
    // Category-specific buckets can be added later as enhancement
    return DEFAULT_AGING_BUCKETS;
  }

  /**
   * Assign an aging bucket to a batch based on its age
   */
  assignBucket(ageDays: number, buckets: AgingBucket[]): AgingBucket {
    // Buckets should be sorted by min ascending
    for (const bucket of buckets) {
      if (ageDays >= bucket.min && ageDays <= bucket.max) {
        return bucket;
      }
    }
    // Fallback: return last bucket (should be 90+ with Infinity)
    return buckets[buckets.length - 1];
  }

  /**
   * Fetch all inventory batches with quantity > 0, including product and location relations
   * @param locationId Optional filter by location
   * @param categoryId Optional filter by category
   */
  async getAllRemainingInventory(locationId?: string, categoryId?: string) {
    const whereClause: any = {
      quantity: { gt: 0 },
    };

    // Push filters to database query for efficiency
    if (locationId) {
      whereClause.locationId = locationId;
    }

    if (categoryId) {
      whereClause.product = {
        categoryId: categoryId,
      };
    }

    return await this.prisma.inventory.findMany({
      where: whereClause,
      include: {
        product: {
          include: {
            category: true,
          },
        },
        location: true,
      },
      orderBy: {
        receivedAt: 'asc', // Oldest first for FIFO context
      },
    });
  }

  /**
   * Classify all inventory batches into aging buckets
   * @param locationId Optional filter by location (pushed to DB query)
   * @param categoryId Optional filter by category (pushed to DB query)
   * @param skipCache Force fresh data fetch (default: false)
   */
  async classifyInventoryAging(
    locationId?: string,
    categoryId?: string,
    skipCache = false,
  ): Promise<AgedInventoryBatch[]> {
    const cacheKey = this.getCacheKey(locationId, categoryId);

    // Check cache first
    if (!skipCache) {
      const cached = this.agingCache.get(cacheKey);
      if (cached && this.isCacheValid(cached)) {
        console.log(
          `[InventoryAgingService] Using cached aging data for ${cacheKey} (${cached.agedBatches.length} batches, cached ${Math.floor((Date.now() - cached.timestamp) / 1000)}s ago)`,
        );
        return cached.agedBatches;
      }
    }

    // Fetch from database with filters pushed down
    const batches = await this.getAllRemainingInventory(locationId, categoryId);
    const agedBatches: AgedInventoryBatch[] = [];

    for (const batch of batches) {
      const ageDays = this.calculateAge(batch.receivedAt);
      const batchCategoryId = batch.product.categoryId;
      const bucketConfig = this.getAgingBucketsForCategory(batchCategoryId);
      const bucket = this.assignBucket(ageDays, bucketConfig.buckets);
      const cashValue = new Decimal(batch.quantity).mul(batch.unitCost);

      agedBatches.push({
        batch: batch as any,
        ageDays,
        bucket,
        cashValue,
      });
    }

    // Store in cache
    this.agingCache.set(cacheKey, {
      agedBatches,
      timestamp: Date.now(),
    });

    console.log(
      `[InventoryAgingService] Fetched and cached ${agedBatches.length} aged batches for ${cacheKey}`,
    );

    return agedBatches;
  }

  /**
   * Aggregate aging data into summary by buckets
   */
  aggregateAgingSummary(agedBatches: AgedInventoryBatch[]): AgingSummary {
    const bucketMap = new Map<
      string,
      { cash: Decimal; units: number; bucket: AgingBucket }
    >();
    let totalCash = new Decimal(0);
    let totalUnits = 0;

    for (const agedBatch of agedBatches) {
      const bucketKey = `${agedBatch.bucket.label}-${agedBatch.bucket.min}-${agedBatch.bucket.max}`;
      if (!bucketMap.has(bucketKey)) {
        bucketMap.set(bucketKey, {
          cash: new Decimal(0),
          units: 0,
          bucket: agedBatch.bucket,
        });
      }

      const entry = bucketMap.get(bucketKey)!;
      entry.cash = entry.cash.add(agedBatch.cashValue);
      entry.units += agedBatch.batch.quantity;
      totalCash = totalCash.add(agedBatch.cashValue);
      totalUnits += agedBatch.batch.quantity;
    }

    const bucketSummaries: BucketSummary[] = [];
    for (const [, data] of bucketMap) {
      const percentage =
        totalCash.gt(0)
          ? data.cash.div(totalCash).mul(100).toNumber()
          : 0;
      bucketSummaries.push({
        bucket: data.bucket,
        cashValue: data.cash,
        unitCount: data.units,
        percentageOfTotal: percentage,
      });
    }

    // Sort by bucket min (ascending)
    bucketSummaries.sort((a, b) => a.bucket.min - b.bucket.min);

    return {
      buckets: bucketSummaries,
      totalCashTiedUp: totalCash,
      totalUnits,
    };
  }

  /**
   * Calculate risk level for a product based on aging and cash value
   */
  calculateProductRiskLevel(
    productData: {
      batches: AgedInventoryBatch[];
      totalCash: Decimal;
      oldestAge: number;
    },
    bucketDistribution: BucketSummary[],
  ): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    // Calculate percentage in high-risk buckets (61+ days)
    let highRiskCash = new Decimal(0);
    for (const bucket of bucketDistribution) {
      if (bucket.bucket.min >= 61) {
        highRiskCash = highRiskCash.add(bucket.cashValue);
      }
    }
    const highRiskPercentage =
      productData.totalCash.gt(0)
        ? highRiskCash.div(productData.totalCash).mul(100).toNumber()
        : 0;

    // Risk criteria
    if (productData.oldestAge >= 90 || highRiskPercentage >= 50) {
      return 'CRITICAL';
    }
    if (productData.oldestAge >= 60 || highRiskPercentage >= 30) {
      return 'HIGH';
    }
    if (productData.oldestAge >= 45 || highRiskPercentage >= 15) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  /**
   * Calculate weighted average age for a set of batches (weighted by quantity)
   */
  calculateWeightedAverageAge(batches: AgedInventoryBatch[]): number {
    let totalWeight = 0;
    let weightedSum = 0;

    for (const batch of batches) {
      const weight = batch.batch.quantity;
      totalWeight += weight;
      weightedSum += batch.ageDays * weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Count products with significant inventory in 90+ day bucket
   */
  countAtRiskProducts(batches: AgedInventoryBatch[]): number {
    const productRiskMap = new Map<string, boolean>();

    for (const batch of batches) {
      if (batch.bucket.min >= 90) {
        const productId = batch.batch.productId;
        productRiskMap.set(productId, true);
      }
    }

    return productRiskMap.size;
  }

  /**
   * Analyze aging for each product (identify slow movers)
   */
  analyzeProductAging(
    agedBatches: AgedInventoryBatch[],
  ): ProductAgingAnalysis[] {
    const productMap = new Map<
      string,
      {
        product: AgedInventoryBatch['batch']['product'];
        batches: AgedInventoryBatch[];
        totalCash: Decimal;
        totalUnits: number;
        oldestAge: number;
      }
    >();

    for (const agedBatch of agedBatches) {
      const productId = agedBatch.batch.productId;
      if (!productMap.has(productId)) {
        productMap.set(productId, {
          product: agedBatch.batch.product,
          batches: [],
          totalCash: new Decimal(0),
          totalUnits: 0,
          oldestAge: 0,
        });
      }

      const entry = productMap.get(productId)!;
      entry.batches.push(agedBatch);
      entry.totalCash = entry.totalCash.add(agedBatch.cashValue);
      entry.totalUnits += agedBatch.batch.quantity;
      entry.oldestAge = Math.max(entry.oldestAge, agedBatch.ageDays);
    }

    const analyses: ProductAgingAnalysis[] = [];
    for (const [productId, data] of productMap) {
      const bucketDistribution = this.aggregateAgingSummary(data.batches)
        .buckets;
      const riskLevel = this.calculateProductRiskLevel(data, bucketDistribution);

      analyses.push({
        productId: productId,
        productName: data.product.name,
        categoryName: data.product.category?.name || null,
        totalCashTiedUp: data.totalCash,
        totalUnits: data.totalUnits,
        oldestBatchAge: data.oldestAge,
        bucketDistribution: bucketDistribution,
        riskLevel: riskLevel,
      });
    }

    // Sort by total cash tied up (descending) to highlight expensive slow movers
    analyses.sort((a, b) => {
      const diff = b.totalCashTiedUp.sub(a.totalCashTiedUp);
      return diff.gt(0) ? 1 : diff.lt(0) ? -1 : 0;
    });

    return analyses;
  }

  /**
   * Analyze aging by location
   */
  analyzeLocationAging(
    agedBatches: AgedInventoryBatch[],
  ): LocationAgingAnalysis[] {
    const locationMap = new Map<
      string,
      {
        location: AgedInventoryBatch['batch']['location'];
        batches: AgedInventoryBatch[];
      }
    >();

    for (const agedBatch of agedBatches) {
      const locationId = agedBatch.batch.locationId;
      if (!locationMap.has(locationId)) {
        locationMap.set(locationId, {
          location: agedBatch.batch.location,
          batches: [],
        });
      }
      locationMap.get(locationId)!.batches.push(agedBatch);
    }

    const analyses: LocationAgingAnalysis[] = [];
    for (const [locationId, data] of locationMap) {
      const summary = this.aggregateAgingSummary(data.batches);
      const atRiskProducts = this.countAtRiskProducts(data.batches);

      analyses.push({
        locationId: locationId,
        locationName: data.location.name,
        totalCashTiedUp: summary.totalCashTiedUp,
        totalUnits: summary.totalUnits,
        bucketDistribution: summary.buckets,
        atRiskProducts: atRiskProducts,
      });
    }

    return analyses;
  }

  /**
   * Analyze aging by category (critical for pharmacy operations)
   */
  analyzeCategoryAging(
    agedBatches: AgedInventoryBatch[],
  ): CategoryAgingAnalysis[] {
    const categoryMap = new Map<
      string,
      {
        category: { id: string; name: string };
        batches: AgedInventoryBatch[];
      }
    >();

    for (const agedBatch of agedBatches) {
      const categoryId = agedBatch.batch.product.categoryId;
      if (categoryId === null) {
        continue; // Skip uncategorized
      }

      if (!categoryMap.has(categoryId)) {
        const category = agedBatch.batch.product.category;
        if (!category) {
          continue;
        }
        categoryMap.set(categoryId, {
          category: category,
          batches: [],
        });
      }
      categoryMap.get(categoryId)!.batches.push(agedBatch);
    }

    const analyses: CategoryAgingAnalysis[] = [];
    for (const [categoryId, data] of categoryMap) {
      const summary = this.aggregateAgingSummary(data.batches);
      const averageAge = this.calculateWeightedAverageAge(data.batches);

      analyses.push({
        categoryId: categoryId,
        categoryName: data.category.name,
        totalCashTiedUp: summary.totalCashTiedUp,
        totalUnits: summary.totalUnits,
        bucketDistribution: summary.buckets,
        averageAge: averageAge,
      });
    }

    // Sort by total cash tied up (descending)
    analyses.sort((a, b) => {
      const diff = b.totalCashTiedUp.sub(a.totalCashTiedUp);
      return diff.gt(0) ? 1 : diff.lt(0) ? -1 : 0;
    });

    return analyses;
  }

  /**
   * Generate actionable signals from aging analysis
   */
  generateActionableSignals(
    productAnalyses: ProductAgingAnalysis[],
    categoryAnalyses: CategoryAgingAnalysis[],
    locationAnalyses: LocationAgingAnalysis[],
  ): ActionableSignal[] {
    const signals: ActionableSignal[] = [];

    // AT_RISK inventory signals (products)
    for (const product of productAnalyses) {
      if (['HIGH', 'CRITICAL'].includes(product.riskLevel)) {
        let cashAtRisk = new Decimal(0);
        for (const bucket of product.bucketDistribution) {
          if (bucket.bucket.min >= 61) {
            cashAtRisk = cashAtRisk.add(bucket.cashValue);
          }
        }

        const recommendedActions: string[] = [];
        if (product.oldestBatchAge >= 90) {
          recommendedActions.push('Discount immediately');
          recommendedActions.push('Stop reordering');
        }
        if (product.oldestBatchAge >= 60) {
          recommendedActions.push('Consider price adjustment');
          recommendedActions.push('Transfer to other location');
        }

        signals.push({
          type: 'AT_RISK',
          severity: product.riskLevel,
          entityType: 'PRODUCT',
          entityId: product.productId,
          entityName: product.productName,
          message: `Product has ${product.oldestBatchAge} day old inventory with $${cashAtRisk.toFixed(2)} at risk`,
          recommendedActions: recommendedActions,
          cashAtRisk: cashAtRisk,
        });
      }
    }

    // SLOW_MOVING_EXPENSIVE signals
    for (const product of productAnalyses) {
      if (
        product.totalCashTiedUp.gt(SIGNAL_THRESHOLDS.SLOW_MOVING_THRESHOLD) &&
        product.oldestBatchAge > 60
      ) {
        signals.push({
          type: 'SLOW_MOVING_EXPENSIVE',
          severity: product.totalCashTiedUp.gt(
            SIGNAL_THRESHOLDS.CRITICAL_CASH_THRESHOLD,
          )
            ? 'CRITICAL'
            : 'HIGH',
          entityType: 'PRODUCT',
          entityId: product.productId,
          entityName: product.productName,
          message: `High-value product ($${product.totalCashTiedUp.toFixed(2)}) with slow movement (${product.oldestBatchAge} days)`,
          recommendedActions: [
            'Price adjustment',
            'Supplier renegotiation',
            'Review purchasing strategy',
          ],
          cashAtRisk: product.totalCashTiedUp,
        });
      }
    }

    // OVERSTOCKED_CATEGORY signals
    for (const category of categoryAnalyses) {
      if (
        category.totalCashTiedUp.gt(SIGNAL_THRESHOLDS.OVERSTOCK_THRESHOLD) &&
        category.averageAge > 45
      ) {
        signals.push({
          type: 'OVERSTOCKED_CATEGORY',
          severity: category.totalCashTiedUp.gt(
            SIGNAL_THRESHOLDS.CRITICAL_CATEGORY_THRESHOLD,
          )
            ? 'CRITICAL'
            : 'HIGH',
          entityType: 'CATEGORY',
          entityId: category.categoryId,
          entityName: category.categoryName,
          message: `Category has $${category.totalCashTiedUp.toFixed(2)} tied up with ${category.averageAge.toFixed(1)} day average age`,
          recommendedActions: [
            'Reduce purchasing',
            'Adjust assortment',
            'Review category strategy',
          ],
          cashAtRisk: category.totalCashTiedUp,
        });
      }
    }

    // Sort by severity (CRITICAL first) then cash at risk
    signals.sort((a, b) => {
      const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      const severityDiff =
        severityOrder[a.severity] - severityOrder[b.severity];
      if (severityDiff !== 0) {
        return severityDiff;
      }
      const aCash = a.cashAtRisk || new Decimal(0);
      const bCash = b.cashAtRisk || new Decimal(0);
      const diff = bCash.sub(aCash);
      return diff.gt(0) ? 1 : diff.lt(0) ? -1 : 0;
    });

    return signals;
  }
}

