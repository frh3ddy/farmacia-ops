export interface ExtractCostsRequest {
  locationIds: string[];
  costBasis: 'DESCRIPTION';
  batchSize?: number | string | null;
  extractionSessionId?: string | null;
}

export interface ApproveBatchRequest {
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

export interface ApproveCostsRequest {
  cutoverId: string;
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
  rejectedProducts?: string[] | null;
  effectiveAt?: string | null;
}

export interface InitiateCutoverRequest {
  cutoverDate: string;
  locationIds: string[];
  costBasis: 'SQUARE_COST' | 'DESCRIPTION' | 'MANUAL_INPUT' | 'AVERAGE_COST';
  ownerApproved: boolean;
  approvalId?: string | null;
  manualCosts?: Array<{ productId: string; cost: number }> | null;
  batchSize?: number | string | null;
  cutoverId?: string | null;
}

export interface PreviewCutoverRequest {
  cutoverDate: string;
  locationIds: string[];
  costBasis: 'SQUARE_COST' | 'DESCRIPTION' | 'MANUAL_INPUT' | 'AVERAGE_COST';
  approvedCosts?: Array<{ productId: string; cost: number }> | null;
}

