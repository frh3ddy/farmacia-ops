export type AgeBucket = { label: string; min: number; max: number | null };
export type BucketDistribution = { bucket: AgeBucket; cashValue: number; unitCount: number; percentageOfTotal: number };

export type AgingSummary = {
  buckets: BucketDistribution[];
  totalCashTiedUp: number;
  totalUnits: number;
};

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ProductAging = {
  productId: string;
  productName: string;
  categoryName: string | null;
  totalCashTiedUp: number;
  totalUnits: number;
  oldestBatchAge: number;
  bucketDistribution: BucketDistribution[];
  riskLevel: RiskLevel;
};

export type LocationAging = {
  locationId: string;
  locationName: string;
  totalCashTiedUp: number;
  totalUnits: number;
  bucketDistribution: BucketDistribution[];
  atRiskProducts: number;
};

export type CategoryAging = {
  categoryId: string;
  categoryName: string;
  totalCashTiedUp: number;
  totalUnits: number;
  bucketDistribution: BucketDistribution[];
  averageAge: number;
};

export type SignalType = "AT_RISK" | "SLOW_MOVING_EXPENSIVE" | "OVERSTOCKED_CATEGORY";

export type ActionableSignal = {
  type: SignalType;
  severity: RiskLevel;
  entityType: string;
  entityId: string;
  entityName: string;
  message: string;
  recommendedActions: string[];
  cashAtRisk: number | null;
};
