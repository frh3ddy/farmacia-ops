import type { Supplier } from "../ops/types";

export type MigrationStatus = "PENDING" | "APPROVED" | "SKIPPED";
export type CostBasis = "SQUARE_COST" | "DESCRIPTION" | "MANUAL_INPUT" | "AVERAGE_COST";

export type ExtractedCostEntry = {
  supplier: string;
  amount: number;
  month?: string | null;
  day?: number | null;
  originalLine: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  supplierId?: string | null;
  editedSupplierName?: string | null;
  editedCost?: number | null;
  editedEffectiveDate?: string | null;
  isSelected?: boolean;
  matchedByInitial?: boolean;
};

export type SellingPrice = { priceCents: number; currency: string };
export type SellingPriceRange = { minCents: number; maxCents: number; currency: string };
export type SellingPriceVariation = { variationId: string; variationName?: string | null; priceCents: number; currency: string };
export type PriceGuard = {
  hasSellingPrice: boolean;
  minSellingPriceCents?: number;
  selectedCostCents?: number;
  isCostTooHigh: boolean;
  message?: string | null;
};

export type CostExtractionResult = {
  productId: string;
  productName: string;
  originalDescription: string;
  extractedEntries: ExtractedCostEntry[];
  selectedCost?: number | null;
  selectedSupplierId?: string | null;
  selectedSupplierName?: string | null;
  imageUrl?: string | null;
  sellingPrices?: SellingPriceVariation[] | null;
  sellingPrice?: SellingPrice | null;
  sellingPriceRange?: SellingPriceRange | null;
  priceGuard?: PriceGuard | null;
  extractionErrors?: string[];
  requiresManualReview?: boolean;
  migrationStatus?: MigrationStatus;
  isAlreadyApproved?: boolean;
  existingApprovedCost?: number | null;
};

export type ApprovedItemSummary = {
  productId: string;
  productName: string | null;
  imageUrl: string | null;
  approvedCost: number | null;
  source: string;
  approvedAt: string | null;
  sellingPriceCents: number | null;
  sellingPriceCurrency: string | null;
};

export type SkippedItemSummary = { productId: string; productName: string | null; imageUrl: string | null };

/** Runtime shape of `result` from POST extract-costs / continue-batch — the
 * DTO in the API only calls this `CostApprovalRequest` (it's reused as both
 * a request and response shape server-side); `cutoverId` is present at
 * runtime even though it's not declared on that interface. */
export type ExtractCostsResult = {
  cutoverId?: string | null;
  locationIds: string[];
  extractionResults: CostExtractionResult[];
  totalProducts: number;
  productsWithExtraction: number;
  productsRequiringManualInput: number;
  batchSize?: number | null;
  currentBatch?: number | null;
  totalBatches?: number | null;
  processedItems?: number | null;
  totalItems?: number | null;
  isComplete?: boolean;
  canContinue?: boolean;
  extractionSessionId?: string | null;
  allApprovedItems?: ApprovedItemSummary[];
  allSkippedItems?: SkippedItemSummary[];
  approvedCount?: number;
  skippedCount?: number;
};

export type ExtractionSessionStatus = "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export type ExtractionBatchSummary = {
  id: string;
  batchNumber: number;
  status: "EXTRACTED" | "APPROVED" | "REJECTED";
  extractedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
};

export type ExtractionSessionSummary = {
  id: string;
  cutoverId?: string | null;
  locationIds: string[];
  currentBatch: number;
  totalBatches?: number | null;
  totalItems: number;
  processedItems: number;
  batchSize: number;
  batchCount?: number;
  learnedSupplierInitials?: Record<string, string[]> | null;
  status: ExtractionSessionStatus;
  createdAt: string;
  updatedAt: string;
  batches?: ExtractionBatchSummary[];
  /** Backend sends arrays here (of ids on some paths, full result objects on
   * others — the legacy code only ever read .length off either shape), so
   * the port only keeps counts, computed once when fetched. */
  itemsByStatus?: {
    pending: unknown[];
    approved: unknown[];
    skipped: unknown[];
  };
};

export type SessionItemCounts = { pending: number; approved: number; skipped: number };

export type MigrationErrorEntry = {
  productId?: string | null;
  productName?: string | null;
  errorType: string;
  message: string;
  recommendation?: string | null;
};

export type MigrationResult = {
  cutoverId: string;
  cutoverDate: string;
  locationsProcessed: number;
  productsProcessed: number;
  openingBalancesCreated: number;
  errors: MigrationErrorEntry[];
  warnings: { productId?: string | null; productName?: string | null; message: string; recommendation?: string | null }[];
  batchSize?: number | null;
  currentBatch?: number | null;
  totalBatches?: number | null;
  processedItems?: number | null;
  totalItems?: number | null;
  skippedItems?: number;
  isComplete?: boolean;
  canContinue?: boolean;
};

/** ApiError shape from apiHelpers.jsx's parseApiResponse — used throughout
 * the extraction pipeline for structured, recoverable errors (as opposed to
 * a plain string message). */
export type StructuredError = {
  code: string;
  message: string;
  userMessage: string;
  recoveryAction?: string | null;
  canRetry?: boolean;
  canResume?: boolean;
};

export type CutoverError = string | StructuredError;

export type SupplierSuggestion = {
  id: string | null;
  name: string;
  contactInfo: string | null;
  matchType: "initial" | "name" | "mapping";
  isExactMatch: boolean;
};

export type { Supplier };
