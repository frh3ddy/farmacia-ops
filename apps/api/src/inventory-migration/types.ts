import { Prisma } from '@prisma/client';

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
  provider: string;
  amount: number;
  month?: string | null;
  lineNumber?: number | null;
  originalLine: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface CostExtractionResult {
  productId: string;
  productName: string;
  originalDescription: string;
  extractedEntries: ExtractedCostEntry[];
  selectedCost?: number | null;
  extractionErrors: string[];
  requiresManualReview: boolean;
}

export interface CostApprovalRequest {
  cutoverId: string;
  locationIds: string[];
  costBasis: 'DESCRIPTION';
  extractionResults: CostExtractionResult[];
  totalProducts: number;
  productsWithExtraction: number;
  productsRequiringManualInput: number;
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



