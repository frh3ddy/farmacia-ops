import { Prisma } from '@prisma/client';

export type MigrationStatus = 'PENDING' | 'APPROVED' | 'SKIPPED';

export interface CutoverInput {
  cutoverDate: Date;
  locationIds: string[];
  costBasis: 'SQUARE_COST' | 'DESCRIPTION' | 'MANUAL_INPUT' | 'AVERAGE_COST';
  ownerApproved: boolean;
  ownerApprovedAt?: Date | null;
  ownerApprovedBy?: string | null;
  approvedCosts?: { productId: string; cost: Prisma.Decimal }[] | null;
}

export interface ExtractedCostEntry {
  supplier: string;
  amount: number;
  month?: string | null;
  lineNumber?: number | null;
  originalLine: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  supplierId?: string | null; // Linked supplier ID
  isEditable?: boolean; // For UI
  suggestedSuppliers?: Array<{id: string; name: string}>; // For autocomplete
  addToHistory?: boolean; // Whether to add this entry to supplier cost history
  editedSupplierName?: string | null; // User-edited supplier name for this entry
  editedCost?: number | null; // User-edited cost for this entry
  editedEffectiveDate?: string | null; // User-edited effective date (ISO string) for this entry
  isSelected?: boolean; // Whether this entry is selected as the product cost
}

export interface CostExtractionResult {
  productId: string;
  productName: string;
  originalDescription: string;
  extractedEntries: ExtractedCostEntry[];
  selectedCost?: number | null;
  selectedSupplierId?: string | null; // Selected supplier ID
  selectedSupplierName?: string | null; // Selected supplier name
  isPreferredSupplier?: boolean; // Whether this supplier is preferred for the product
  latestCostHistoryDate?: string | null; // Latest cost history date for selected supplier
  imageUrl?: string | null; // Product image URL from Square catalog

  // --- Selling price (Square catalog) - extraction-time only ---
  sellingPrices?: Array<{
    variationId: string;
    variationName?: string | null;
    priceCents: number;
    currency: string;
  }>;

  // Primary selling price used for validation: MIN across variations
  sellingPrice?: { priceCents: number; currency: string } | null;

  // Only set when product has multiple variation prices
  sellingPriceRange?: { minCents: number; maxCents: number; currency: string } | null;

  // Margin guardrail for UI: selectedCost >= MIN selling price
  priceGuard?: {
    hasSellingPrice: boolean;
    minSellingPriceCents?: number;
    selectedCostCents?: number;
    isCostTooHigh: boolean;
    message?: string | null;
  };

  extractionErrors: string[];
  requiresManualReview: boolean;
  migrationStatus?: MigrationStatus; // Migration status: PENDING, APPROVED, SKIPPED
  // Already approved cost metadata
  isAlreadyApproved?: boolean; // Whether this product already has an approved cost
  existingApprovedCost?: Prisma.Decimal; // The existing approved cost amount
  existingApprovalDate?: Date; // When the cost was approved
  existingCutoverId?: string; // Which cutover the approval is from
}

export interface CostApprovalRequest {
  cutoverId: string;
  locationIds: string[];
  costBasis: 'DESCRIPTION';
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
}

export interface CostApprovalResponse {
  approved: boolean;
  approvedCosts: { productId: string; cost: Prisma.Decimal; source: string }[];
  rejectedProducts: string[];
  approvedAt?: Date | null;
  approvedBy?: string | null;
}

export interface SquareInventoryItem {
  catalogObjectId: string;
  locationId: string;
  quantity: number;
  catalogObject?: any | null;
}

export interface SquareCatalogObject {
  id: string;
  type: 'ITEM_VARIATION';
  itemVariationData?: {
    name?: string | null;
    sku?: string | null;
    priceMoney?: any | null;
  } | null;
  // Product name from related ITEM object
  productName?: string | null;
  // Product description from related ITEM object
  productDescription?: string | null;
  // Product image URL from Square catalog
  imageUrl?: string | null;

  // Normalized selling price from variation.priceMoney (cents)
  variationPriceCents?: number | null;
  variationCurrency?: string | null;
}

export interface SquareInventoryCount {
  catalogObjectId: string;
  locationId: string;
  state: 'IN_STOCK' | 'SOLD' | 'RESERVED_FOR_SALE' | 'WASTE' | 'DAMAGED';
  quantity: string;
}

export interface OpeningBalanceItem {
  productId: string;
  locationId: string;
  quantity: number;
  unitCost: Prisma.Decimal;
  receivedAt: Date;
  source: 'OPENING_BALANCE';
  costSource: string;
  notes?: string | null;
}

export interface MigrationError {
  productId?: string | null;
  productName?: string | null;
  locationId?: string | null;
  locationName?: string | null;
  errorType:
    | 'UNMAPPED_PRODUCT'
    | 'MISSING_COST'
    | 'INVALID_QUANTITY'
    | 'DATABASE_ERROR'
    | 'SQUARE_API_ERROR'
    | 'VALIDATION_ERROR'
    | 'MIGRATION_BLOCKED';
  message: string;
  canProceed: boolean;
}

export interface MigrationWarning {
  productId?: string | null;
  productName?: string | null;
  locationId?: string | null;
  message: string;
  recommendation?: string | null;
}

export interface MigrationResult {
  cutoverId: string;
  cutoverDate: Date;
  locationsProcessed: number;
  productsProcessed: number;
  openingBalancesCreated: number;
  errors: MigrationError[];
  warnings: MigrationWarning[];
  completedAt: Date;
  completedBy?: string | null;
  batchSize?: number | null;
  currentBatch?: number | null;
  totalBatches?: number | null;
  processedItems?: number | null;
  totalItems?: number | null;
  skippedItems?: number; // Count of items that were SKIPPED and excluded from migration
  isComplete?: boolean;
  canContinue?: boolean;
}

export interface CutoverLock {
  isLocked: boolean;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  cutoverDate?: Date | null;
  preventsBackdatedEdits: boolean;
  preventsBackdatedSales: boolean;
  preventsSilentCostChanges: boolean;
}

export interface LocationPreview {
  locationId: string;
  locationName: string;
  products: ProductPreview[];
  totalProducts: number;
  productsWithCost: number;
  productsMissingCost: number;
}

export interface ProductPreview {
  productId: string;
  productName: string;
  quantity: number;
  unitCost?: number | null;
  costSource?: string | null;
  hasCost: boolean;
}

export interface ExtractionSession {
  id: string;
  cutoverId?: string | null;
  locationIds: string[];
  currentBatch: number;
  totalBatches?: number | null;
  totalItems: number;
  processedItems: number;
  batchSize: number;
  lastApprovedBatchId?: string | null;
  lastApprovedProductId?: string | null;
  learnedSupplierInitials?: Record<string, string[]> | null;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemToProcess {
  locationId: string;
  locationName: string;
  squareInventoryItem: any;
  itemKey: string;
}

export interface ExtractionBatch {
  id: string;
  extractionSessionId: string;
  batchNumber: number;
  cutoverId?: string | null;
  locationIds: string[];
  status: 'EXTRACTED' | 'APPROVED' | 'REJECTED';
  extractedAt: Date;
  approvedAt?: Date | null;
  approvedBy?: string | null;
  productIds: string[];
  totalProducts: number;
  productsWithExtraction: number;
  productsRequiringManualInput: number;
  extractionApproved: boolean;
  manualInputApproved: boolean;
  isFullyApproved: boolean;
  lastApprovedProductId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BatchApprovalRequest {
  extractionSessionId: string;
  batchId: string;
  extractionApproved: boolean;
  manualInputApproved: boolean;
  approvedCosts: Array<{
    productId: string;
    cost: number;
    source: string;
    notes?: string | null;
    supplierId?: string | null;
    supplierName?: string | null;
    isPreferred?: boolean;
  }>;
  entriesToAddToHistory?: Array<{
    productId: string;
    supplierName: string;
    supplierId?: string | null;
    cost: number;
    effectiveAt?: string | null;
  }> | null;
  supplierInitialsUpdates?: Array<{
    supplierName: string;
    initials: string[];
  }> | null;
}

export interface BatchApprovalResponse {
  success: boolean;
  batchId: string;
  nextBatchAvailable: boolean;
  lastApprovedProductId: string;
  message: string;
}

export interface ExtractionSessionWithItems {
  id: string;
  cutoverId?: string | null;
  locationIds: string[];
  currentBatch: number;
  totalBatches?: number | null;
  totalItems: number;
  processedItems: number;
  batchSize: number;
  lastApprovedBatchId?: string | null;
  lastApprovedProductId?: string | null;
  learnedSupplierInitials?: Record<string, string[]> | null;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  createdAt: Date;
  updatedAt: Date;
  itemsByStatus: {
    pending: CostExtractionResult[];
    approved: CostExtractionResult[];
    skipped: CostExtractionResult[];
  };
}



