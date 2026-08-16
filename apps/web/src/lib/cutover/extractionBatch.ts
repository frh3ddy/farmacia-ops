import { apiFetch } from "../apiFetch";
import { matchSupplierByInitialOrName, type SupplierNameMapping } from "./supplierMatching";
import type { CostExtractionResult, ExtractCostsResult, ExtractionSessionSummary, SessionItemCounts, Supplier } from "./types";

/**
 * The legacy wizard (index.jsx) had this exact "normalize the extraction
 * response, then merge with whatever was already approved/skipped this
 * session" logic duplicated in three places — the initial extract call, an
 * auto-continue branch inside that same handler, and handleContinueBatch —
 * each ~150 lines, not quite identical (see forceSelectLast below). This is
 * the one shared implementation all three now go through.
 */

/** Fresh extraction (first batch of a session) preserves whatever
 * `isSelected` the backend marked on an entry. Continuing/resuming a
 * session always forces the *last* entry selected regardless of what the
 * backend marked — that's a real, observed behavioral difference in the
 * legacy code between the two call sites, not an accident, so it's kept as
 * an explicit flag rather than silently unified. */
export function normalizeExtractedEntries(
  results: CostExtractionResult[],
  allSuppliers: Supplier[],
  supplierNameMappings: SupplierNameMapping[],
  forceSelectLast: boolean
): CostExtractionResult[] {
  return results.map(productResult => {
    if (!productResult.extractedEntries || productResult.extractedEntries.length === 0) {
      return productResult;
    }

    const entries = productResult.extractedEntries.map((entry, idx) => {
      const match = matchSupplierByInitialOrName(entry.supplier, allSuppliers, supplierNameMappings);
      const isLast = idx === productResult.extractedEntries.length - 1;
      return {
        ...entry,
        editedSupplierName: match.name ?? (forceSelectLast ? entry.supplier : entry.editedSupplierName),
        supplierId: match.id ?? entry.supplierId,
        matchedByInitial: match.matchedByInitial,
        isSelected: forceSelectLast ? isLast : (entry.isSelected ?? isLast),
      };
    });

    const selected = entries.find(e => e.isSelected) ?? entries[entries.length - 1];

    return {
      ...productResult,
      extractedEntries: entries,
      selectedSupplierName: selected.editedSupplierName || selected.supplier,
      selectedSupplierId: selected.supplierId ?? null,
      selectedCost: selected.editedCost ?? selected.amount,
    };
  });
}

/** allApprovedItems/allSkippedItems → placeholder CostExtractionResult rows
 * so they can render in the Approved/Discarded tabs alongside the current
 * batch. Identical across all three legacy call sites. */
export function buildSessionPlaceholders(result: ExtractCostsResult): CostExtractionResult[] {
  const placeholders: CostExtractionResult[] = [];

  for (const item of result.allApprovedItems ?? []) {
    placeholders.push({
      productId: item.productId,
      productName: item.productName ?? "Unknown Product",
      originalDescription: "",
      imageUrl: item.imageUrl,
      selectedCost: item.approvedCost,
      selectedSupplierName: item.source === "DESCRIPTION" ? null : item.source,
      selectedSupplierId: null,
      migrationStatus: "APPROVED",
      extractedEntries: [],
      sellingPrice: item.sellingPriceCents != null ? { priceCents: item.sellingPriceCents, currency: item.sellingPriceCurrency ?? "USD" } : null,
      isAlreadyApproved: true,
      existingApprovedCost: item.approvedCost,
    });
  }

  for (const item of result.allSkippedItems ?? []) {
    placeholders.push({
      productId: item.productId,
      productName: item.productName ?? "Unknown Product",
      originalDescription: "",
      imageUrl: item.imageUrl,
      migrationStatus: "SKIPPED",
      extractedEntries: [],
    });
  }

  return placeholders;
}

/** Merge fresh batch results with whatever's already approved/skipped this
 * session, sourced from the backend's allApprovedItems/allSkippedItems —
 * not local React state. The legacy auto-continue branch merged against
 * local state instead (the other two call sites used the backend list);
 * that was the odd one out and a real staleness risk (two batches approved
 * between renders could desync), so all three now use the backend list. */
export function mergeBatchResults(
  newBatchResults: CostExtractionResult[],
  sessionPlaceholders: CostExtractionResult[],
  forcePendingStatus: boolean
): CostExtractionResult[] {
  const normalizedNewBatch = forcePendingStatus
    ? newBatchResults.map(r => (r.isAlreadyApproved ? r : { ...r, migrationStatus: r.migrationStatus ?? "PENDING" }))
    : newBatchResults;

  const newBatchIds = new Set(normalizedNewBatch.map(r => r.productId));
  const preserved = sessionPlaceholders.filter(r => !newBatchIds.has(r.productId));

  return [...preserved, ...normalizedNewBatch];
}

export type SessionExtras = {
  currentBatchId: string | null;
  learnedSupplierInitials: Record<string, string[]> | null;
  itemsByStatus: SessionItemCounts | null;
};

/** Every one of the three legacy call sites re-fetched the full session
 * afterward just to read the latest batch id and learned initials — same
 * fetch, same fields, now in one place. */
export async function fetchSessionExtras(sessionId: string): Promise<SessionExtras> {
  try {
    const body = await apiFetch<{ success: boolean; session: ExtractionSessionSummary }>(
      `/admin/inventory/cutover/extraction-session/${sessionId}`
    );
    if (!body.success || !body.session) {
      return { currentBatchId: null, learnedSupplierInitials: null, itemsByStatus: null };
    }
    const batches = body.session.batches ?? [];
    const latestBatch = batches.length > 0 ? batches[batches.length - 1] : null;
    const raw = body.session.itemsByStatus;
    return {
      currentBatchId: latestBatch?.id ?? null,
      learnedSupplierInitials: body.session.learnedSupplierInitials ?? null,
      itemsByStatus: raw ? { pending: raw.pending.length, approved: raw.approved.length, skipped: raw.skipped.length } : null,
    };
  } catch {
    return { currentBatchId: null, learnedSupplierInitials: null, itemsByStatus: null };
  }
}
