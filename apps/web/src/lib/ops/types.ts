export type CatalogMapping = {
  id: string;
  squareVariationId: string;
  syncedAt: string;
  locationId: string | null;
  employeeId?: string | null;
  product?: { id: string; name: string } | null;
  location?: { id: string; name: string } | null;
};

export type Product = {
  id: string;
  name: string;
  squareProductName: string | null;
  sku: string | null;
  createdAt: string;
  category?: { id: string; name: string } | null;
  catalogMappings?: CatalogMapping[];
  supplierCount: number;
  searchAliases?: string[];
  tracksInventory?: boolean;
};

export type Employee = {
  id: string;
  name: string;
};

export type YastasWallet = {
  locationId: string;
  balance: string;
  updatedAt: string;
};

export type YastasOperation = {
  id: string;
  employeeId: string;
  locationId: string;
  direction: "IN" | "OUT";
  faceAmount: string;
  yastasReceiptRef: string | null;
  occurredAt: string;
  createdAt: string;
};

export type YastasSettlement = {
  id: string;
  locationId: string;
  periodStart: string;
  periodEnd: string;
  amountEarned: string;
  status: "PROVISIONAL" | "CONFIRMED";
  reportedAt: string | null;
  paidAt: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type Supplier = {
  id: string;
  name: string;
  initials: string[];
  contactInfo: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SupplierProductRow = {
  id: string;
  productId: string;
  productName: string;
  name: string;
  sku: string | null;
  cost: string;
  isPreferred: boolean;
  notes: string | null;
  updatedAt: string | null;
};

export type CostHistoryEntry = {
  id: string;
  cost: string;
  effectiveAt: string;
  createdAt: string;
  source: string;
  isCurrent: boolean;
};

/** Row shape from GET /admin/inventory/cutover/products/:id/suppliers — a
 * supplier as seen from one product's point of view (includes that
 * product's cost with this supplier). */
export type ProductSupplier = {
  id: string;
  name: string;
  contactInfo: string | null;
  isActive: boolean;
  cost: string;
  isPreferred: boolean;
  notes: string | null;
};

export type ProductSupplierCostHistoryGroup = {
  supplierId: string;
  supplierName: string;
  costHistory: CostHistoryEntry[];
};
