import { apiFetch } from "../apiFetch";
import type { CostBasis, ExtractCostsResult, ExtractedCostEntry, ExtractionSessionSummary, MigrationResult, Supplier, SupplierSuggestion } from "./types";

const BASE = "/admin/inventory/cutover";

export async function fetchAllSuppliers(): Promise<Supplier[]> {
  const body = await apiFetch<{ data: Supplier[] }>(`${BASE}/suppliers`);
  return body.data;
}

export async function fetchInProgressSessions(locationId?: string | null): Promise<ExtractionSessionSummary[]> {
  const url = locationId ? `${BASE}/extraction-sessions?locationId=${locationId}` : `${BASE}/extraction-sessions`;
  const body = await apiFetch<{ sessions: ExtractionSessionSummary[] }>(url);
  return body.sessions.filter(s => s.status === "IN_PROGRESS");
}

export type ExtractCostsPayload = {
  locationIds: string[];
  costBasis: "DESCRIPTION";
  batchSize?: number | null;
  newBatchSize?: number | null;
  extractionSessionId?: string | null;
  cutoverDate?: string | null;
};

export async function extractCosts(payload: ExtractCostsPayload): Promise<ExtractCostsResult> {
  const body = await apiFetch<{ result: ExtractCostsResult }>(`${BASE}/extract-costs`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return body.result;
}

export type ApproveItemPayload = {
  cutoverId: string;
  productId: string;
  cost: number;
  source: string;
  notes?: string | null;
  extractedEntries?: unknown[];
  selectedSupplierId?: string | null;
  selectedSupplierName?: string | null;
  sellingPrice?: { priceCents: number; currency: string } | null;
  sellingPriceRange?: { minCents: number; maxCents: number; currency: string } | null;
};

export function approveItem(payload: ApproveItemPayload) {
  return apiFetch(`${BASE}/approve-item`, { method: "POST", body: JSON.stringify(payload) });
}

export function discardItem(payload: {
  cutoverId: string;
  productId: string;
  sellingPrice?: { priceCents: number; currency: string } | null;
  sellingPriceRange?: { minCents: number; maxCents: number; currency: string } | null;
}) {
  return apiFetch(`${BASE}/discard-item`, { method: "POST", body: JSON.stringify(payload) });
}

export function restoreItem(payload: { cutoverId: string; productId: string }) {
  return apiFetch(`${BASE}/restore-item`, { method: "POST", body: JSON.stringify(payload) });
}

export type RegenerateExtractionResult = {
  success: boolean;
  productName: string;
  originalDescription: string;
  extractedEntries: ExtractedCostEntry[];
};

export function regenerateExtraction(payload: {
  productId: string;
  description: string;
  persistDescription?: boolean;
  cutoverDate?: string | null;
}) {
  return apiFetch<RegenerateExtractionResult>(`${BASE}/regenerate-extraction`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function markDiscontinued(payload: {
  cutoverId: string;
  productId: string;
  sellingPrice?: { priceCents: number; currency: string } | null;
  sellingPriceRange?: { minCents: number; maxCents: number; currency: string } | null;
}) {
  return apiFetch(`${BASE}/mark-discontinued`, { method: "POST", body: JSON.stringify(payload) });
}

export async function reusePreviousApprovals(cutoverId: string, productIds: string[]) {
  return apiFetch<{ approvedCount: number }>(`${BASE}/reuse-previous-approvals`, {
    method: "POST",
    body: JSON.stringify({ cutoverId, productIds }),
  });
}

export function addSupplierInitial(supplierName: string, initial: string) {
  return apiFetch(`${BASE}/suppliers/add-initial`, {
    method: "POST",
    body: JSON.stringify({ supplierName, initial }),
  });
}

export async function suggestSuppliers(query: string): Promise<SupplierSuggestion[]> {
  const body = await apiFetch<{ suppliers: SupplierSuggestion[] }>(`${BASE}/suppliers/suggest?q=${encodeURIComponent(query)}`);
  return body.suppliers;
}

export type InitiateCutoverPayload = {
  cutoverDate: string;
  locationIds: string[];
  costBasis: CostBasis;
  ownerApproved: boolean;
  approvalId?: string | null;
  batchSize?: number | null;
};

export async function initiateCutover(payload: InitiateCutoverPayload): Promise<MigrationResult> {
  const body = await apiFetch<{ success: boolean; result: MigrationResult; message?: string }>(`${BASE}/initiate`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return body.result;
}

export async function continueCutover(cutoverId: string): Promise<MigrationResult> {
  const body = await apiFetch<{ success: boolean; result: MigrationResult; message?: string }>(`${BASE}/continue`, {
    method: "POST",
    body: JSON.stringify({ cutoverId }),
  });
  return body.result;
}
