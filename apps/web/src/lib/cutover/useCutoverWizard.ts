import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../apiFetch";
import type { Location } from "../types";
import * as api from "./api";
import { buildSessionPlaceholders, fetchSessionExtras, mergeBatchResults, normalizeExtractedEntries } from "./extractionBatch";
import { networkError } from "./errorFormat";
import { findAutoSelectMatch, getSupplierSuggestions, type SupplierNameMapping } from "./supplierMatching";
import type {
  CostBasis,
  CostExtractionResult,
  CutoverError,
  ExtractionSessionSummary,
  MigrationResult,
  SessionItemCounts,
  Supplier,
} from "./types";

export type WizardPhase = "configuring" | "extracting" | "reviewing" | "migrating" | "reporting";
export type ExtractionTab = "extracting" | "approved" | "discarded";

/**
 * Replaces useInventoryMigrationState.jsx + every handler in index.jsx.
 * The legacy version had ~450 lines of near-duplicate "process the
 * extraction response, then merge with session state" logic spread across
 * three call sites — extractCosts/handleContinueBatch here both go through
 * the shared helpers in extractionBatch.ts instead.
 */
export function useCutoverWizard() {
  const [phase, setPhase] = useState<WizardPhase>("configuring");

  // Configuration
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [cutoverDate, setCutoverDate] = useState(new Date().toISOString().split("T")[0]);
  const [costBasis, setCostBasis] = useState<CostBasis>("DESCRIPTION");
  const [batchSize, setBatchSize] = useState(50);

  // Extraction
  const [extractionSessionId, setExtractionSessionId] = useState<string | null>(null);
  const [currentCutoverId, setCurrentCutoverId] = useState<string | null>(null);
  const [extractionResults, setExtractionResults] = useState<CostExtractionResult[]>([]);
  const [extractionTab, setExtractionTab] = useState<ExtractionTab>("extracting");
  const [currentExtractingIndex, setCurrentExtractingIndex] = useState(0);
  const [editedResults, setEditedResults] = useState<Record<string, CostExtractionResult>>({});
  const [allSuppliers, setAllSuppliers] = useState<Supplier[]>([]);
  const [supplierNameMappings, setSupplierNameMappings] = useState<SupplierNameMapping[]>([]);
  const [supplierInitialsMap, setSupplierInitialsMap] = useState<Record<string, string[]>>({});
  const [sessionItemCounts, setSessionItemCounts] = useState<SessionItemCounts | null>(null);
  const [hideProductImageForTransition, setHideProductImageForTransition] = useState(false);
  const [batchComplete, setBatchComplete] = useState(false);

  // Session resume
  const [existingSessions, setExistingSessions] = useState<ExtractionSessionSummary[]>([]);
  const [showSessionSelector, setShowSessionSelector] = useState(false);

  // Migration
  const [migrationResult, setMigrationResult] = useState<MigrationResult | null>(null);
  const [reportData, setReportData] = useState<MigrationResult | null>(null);
  const [confirmingMigration, setConfirmingMigration] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CutoverError | null>(null);

  const dropdownSelectionRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    apiFetch<{ data: Location[] }>("/locations")
      .then(body => setLocations(body.data))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to fetch locations"));
    api.fetchAllSuppliers().then(setAllSuppliers).catch(() => undefined);
  }, []);

  const cutoverId = currentCutoverId ?? extractionSessionId;

  // --- Core extraction call, shared by start/resume/continue ---
  // Declared before its callers below since each of them lists it as a
  // dependency (it closes over selectedLocationId/batchSize/cutoverDate/etc,
  // so callers that don't track it as a dependency would otherwise keep
  // calling a stale copy — see the fixed bug this replaced, caught by
  // testing "resume session" against real data: it silently sent an empty
  // locationIds array and ignored the user's batch size).

  const runExtractCosts = useCallback(
    async (opts: { continueExtraction: boolean; newBatchSize?: number | null; explicitSessionId?: string | null }) => {
      setLoading(true);
      setError(null);
      if (!opts.continueExtraction) {
        setExtractionResults([]);
        setExtractionSessionId(null);
        setEditedResults({});
      }

      const sessionIdToUse = opts.explicitSessionId ?? (opts.continueExtraction ? extractionSessionId : null);

      try {
        const result = await api.extractCosts({
          locationIds: selectedLocationId ? [selectedLocationId] : [],
          costBasis: "DESCRIPTION",
          batchSize: opts.continueExtraction ? null : batchSize,
          newBatchSize: opts.continueExtraction ? (opts.newBatchSize ?? (batchSize > 0 ? batchSize : null)) : null,
          extractionSessionId: sessionIdToUse,
          cutoverDate: cutoverDate || null,
        });

        const normalized = normalizeExtractedEntries(
          result.extractionResults ?? [],
          allSuppliers,
          supplierNameMappings,
          opts.continueExtraction
        );
        const placeholders = buildSessionPlaceholders(result);
        const merged = opts.continueExtraction ? mergeBatchResults(normalized, placeholders, true) : normalized;

        if (result.extractionSessionId) {
          setExtractionSessionId(result.extractionSessionId);
          const extras = await fetchSessionExtras(result.extractionSessionId);
          if (extras.learnedSupplierInitials) setSupplierInitialsMap(extras.learnedSupplierInitials);
          if (result.approvedCount !== undefined && result.skippedCount !== undefined) {
            setSessionItemCounts({ approved: result.approvedCount, skipped: result.skippedCount, pending: 0 });
          } else if (extras.itemsByStatus) {
            setSessionItemCounts(extras.itemsByStatus);
          }
        }

        setEditedResults(prev => {
          const keep = new Set(normalized.map(r => r.productId));
          const filtered: typeof prev = {};
          for (const id of keep) if (prev[id]) filtered[id] = prev[id];
          return filtered;
        });
        setExtractionResults(merged);
        setCurrentCutoverId(prev => prev ?? result.cutoverId ?? null);
        setCurrentExtractingIndex(0);

        if (result.isComplete || (merged.filter(r => !r.migrationStatus || r.migrationStatus === "PENDING").length === 0 && merged.length > 0)) {
          setPhase("reviewing");
        } else {
          setPhase("extracting");
        }
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError(networkError(err, !!extractionSessionId));
        }
      } finally {
        setLoading(false);
      }
    },
    [selectedLocationId, batchSize, cutoverDate, extractionSessionId, allSuppliers, supplierNameMappings]
  );

  const handleContinueBatch = useCallback(async () => {
    if (!extractionSessionId) return setError("Missing session ID. Please resume the session first.");
    setBatchComplete(false);
    await runExtractCosts({ continueExtraction: true });
  }, [extractionSessionId, runExtractCosts]);

  // --- Session start / resume ---

  const handleStartExtraction = useCallback(async () => {
    if (!selectedLocationId) return setError("Please select a location");
    if (new Date(cutoverDate) > new Date()) return setError("Cutover date cannot be in the future");
    if (batchSize < 10 || batchSize > 500) return setError("Batch size must be between 10 and 500");

    const sessions = await api.fetchInProgressSessions(selectedLocationId);
    if (sessions.length > 0) {
      setExistingSessions(sessions);
      setShowSessionSelector(true);
      return;
    }
    await runExtractCosts({ continueExtraction: false });
  }, [selectedLocationId, cutoverDate, batchSize, runExtractCosts]);

  const handleStartNewExtraction = useCallback(async () => {
    setShowSessionSelector(false);
    await runExtractCosts({ continueExtraction: false });
  }, [runExtractCosts]);

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      setShowSessionSelector(false);
      setLoading(true);
      setError(null);
      try {
        const body = await apiFetch<{ success: boolean; session: ExtractionSessionSummary }>(
          `/admin/inventory/cutover/extraction-session/${sessionId}`
        );
        if (!body.success) throw new Error("Failed to load session");
        if (body.session.locationIds?.length > 0) setSelectedLocationId(body.session.locationIds[0]);
        if (body.session.learnedSupplierInitials) setSupplierInitialsMap(body.session.learnedSupplierInitials);
        await runExtractCosts({ continueExtraction: true, explicitSessionId: sessionId });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to resume session");
        setLoading(false);
      }
    },
    [runExtractCosts]
  );

  // --- Item actions ---

  const updateItemStatus = useCallback((productId: string, updates: Partial<CostExtractionResult>) => {
    setExtractionResults(prev => prev.map(r => (r.productId === productId ? { ...r, ...updates } : r)));
  }, []);

  const advanceAfterAction = useCallback(() => {
    setCurrentExtractingIndex(prev => {
      const remaining = extractionResultsRef.current.filter(r => !r.migrationStatus || r.migrationStatus === "PENDING").length;
      return prev < remaining - 1 ? prev : Math.max(0, prev - 1);
    });
  }, []);

  // Ref mirror so advanceAfterAction reads fresh state without becoming a dependency storm
  const extractionResultsRef = useRef<CostExtractionResult[]>([]);
  useEffect(() => {
    extractionResultsRef.current = extractionResults;
  }, [extractionResults]);

  const handleDiscardItem = useCallback(
    async (productId: string) => {
      if (!cutoverId) return setError("Missing cutover ID. Please start extraction first.");
      const item = extractionResults.find(r => r.productId === productId);
      setHideProductImageForTransition(true);
      try {
        await api.discardItem({
          cutoverId,
          productId,
          sellingPrice: item?.sellingPrice ?? null,
          sellingPriceRange: item?.sellingPriceRange ?? null,
        });
        updateItemStatus(productId, { migrationStatus: "SKIPPED" });
        setSessionItemCounts(prev => (prev ? { ...prev, skipped: prev.skipped + 1 } : prev));
        advanceAfterAction();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to discard item");
      } finally {
        setHideProductImageForTransition(false);
      }
    },
    [cutoverId, extractionResults, updateItemStatus, advanceAfterAction]
  );

  const handleRestoreItem = useCallback(
    async (productId: string) => {
      if (!cutoverId) return setError("Missing cutover ID. Please start extraction first.");
      try {
        await api.restoreItem({ cutoverId, productId });
        updateItemStatus(productId, { migrationStatus: "PENDING" });
        setSessionItemCounts(prev => (prev ? { ...prev, skipped: Math.max(0, prev.skipped - 1) } : prev));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to restore item");
      }
    },
    [cutoverId, updateItemStatus]
  );

  /** Marks a product permanently discontinued and, in the same action, skips
   * it from this session's queue — mirrors handleDiscardItem, since the
   * backend's markDiscontinued always routes through the same discard logic. */
  const handleMarkDiscontinued = useCallback(
    async (productId: string) => {
      if (!cutoverId) return setError("Missing cutover ID. Please start extraction first.");
      const item = extractionResults.find(r => r.productId === productId);
      setHideProductImageForTransition(true);
      try {
        await api.markDiscontinued({
          cutoverId,
          productId,
          sellingPrice: item?.sellingPrice ?? null,
          sellingPriceRange: item?.sellingPriceRange ?? null,
        });
        updateItemStatus(productId, { migrationStatus: "SKIPPED" });
        setSessionItemCounts(prev => (prev ? { ...prev, skipped: prev.skipped + 1 } : prev));
        advanceAfterAction();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to mark product discontinued");
      } finally {
        setHideProductImageForTransition(false);
      }
    },
    [cutoverId, extractionResults, updateItemStatus, advanceAfterAction]
  );

  /** Re-parses a product's (possibly user-corrected) description. Replaces
   * the regex-parsed entries with the fresh result but preserves any
   * manually-added entries (tagged via originalLine, see ExtractionItemEditor's
   * addManualEntry), re-appending them after the fresh parse so they survive
   * a regenerate. Runs the merge back through normalizeExtractedEntries so
   * isSelected/selectedCost/selectedSupplierName recompute with the last
   * entry selected, matching the existing "last row is selected" convention. */
  const handleRegenerateExtraction = useCallback(
    async (productId: string, description: string) => {
      const result = extractionResults.find(r => r.productId === productId);
      if (!result) return;
      const edited = editedResults[productId] ?? result;

      try {
        const res = await api.regenerateExtraction({ productId, description, cutoverDate: cutoverDate || null });
        const manualEntries = (edited.extractedEntries ?? []).filter(e => e.originalLine === "Manually added");
        const merged: CostExtractionResult = {
          ...edited,
          originalDescription: res.originalDescription,
          extractedEntries: [...res.extractedEntries, ...manualEntries],
        };
        const [normalized] = normalizeExtractedEntries([merged], allSuppliers, supplierNameMappings, true);
        setEditedResults(prev => ({ ...prev, [productId]: normalized }));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to regenerate extraction");
      }
    },
    [extractionResults, editedResults, cutoverDate, allSuppliers, supplierNameMappings]
  );

  const handleReusePreviousApprovals = useCallback(async () => {
    if (!cutoverId) return setError("Missing cutover ID. Please start extraction first.");
    const itemsToReuse = extractionResults.filter(
      r => r.isAlreadyApproved && r.existingApprovedCost != null && r.migrationStatus !== "APPROVED"
    );
    if (itemsToReuse.length === 0) return setError("No items with previous approvals found to reuse.");

    setLoading(true);
    setError(null);
    try {
      const productIds = itemsToReuse.map(r => r.productId);
      const { approvedCount } = await api.reusePreviousApprovals(cutoverId, productIds);
      setExtractionResults(prev =>
        prev.map(r =>
          productIds.includes(r.productId)
            ? { ...r, migrationStatus: "APPROVED", selectedCost: r.existingApprovedCost ?? r.selectedCost, isAlreadyApproved: false }
            : r
        )
      );
      setSessionItemCounts(prev => (prev ? { ...prev, approved: prev.approved + approvedCount } : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to reuse previous approvals");
    } finally {
      setLoading(false);
    }
  }, [cutoverId, extractionResults]);

  /** The initials-learning flow: when a user edits an extracted entry's
   * supplier name to something longer/different than what was extracted,
   * offer to remember that abbreviation for future extractions (matches
   * Supplier.initials / the extraction pipeline's learning behavior). */
  const collectInitialsToLearn = useCallback(
    (result: CostExtractionResult, editedEntries: CostExtractionResult["extractedEntries"]) => {
      const toAdd: { initial: string; supplierName: string }[] = [];
      const originalEntries = result.extractedEntries;
      for (let i = 0; i < editedEntries.length; i++) {
        const edited = editedEntries[i];
        const original = originalEntries[i] ?? edited;
        const originalSupplier = original.supplier;
        const finalName = edited.editedSupplierName || edited.supplier;
        if (!originalSupplier || !finalName || originalSupplier === finalName) continue;
        if (finalName.trim().length <= originalSupplier.trim().length) continue;

        const supplier = allSuppliers.find(s => s.name === finalName);
        const known = [...(supplier?.initials ?? []), ...(supplierInitialsMap[finalName] ?? [])];
        const trimmed = originalSupplier.trim();
        if (known.some(k => k.toLowerCase() === trimmed.toLowerCase())) continue;
        if (toAdd.some(item => item.initial.toLowerCase() === trimmed.toLowerCase() && item.supplierName === finalName)) continue;
        toAdd.push({ initial: trimmed, supplierName: finalName });
      }
      return toAdd;
    },
    [allSuppliers, supplierInitialsMap]
  );

  const handleApproveItem = useCallback(
    async (result: CostExtractionResult) => {
      if (!cutoverId) return setError("Missing cutover ID. Please start extraction first.");

      const edited = editedResults[result.productId] ?? result;
      const hasExtraction = (edited.extractedEntries?.length ?? 0) > 0;
      const selectedEntry = edited.extractedEntries?.find(e => e.isSelected) ?? edited.extractedEntries?.at(-1) ?? null;
      const cost = edited.selectedCost ?? (selectedEntry ? selectedEntry.editedCost ?? selectedEntry.amount : null);

      if (cost == null || cost <= 0) return setError("Please enter a valid cost");
      if (!hasExtraction && !edited.selectedSupplierName) return setError("Please enter a supplier name");

      const supplierName = edited.selectedSupplierName || selectedEntry?.editedSupplierName || selectedEntry?.supplier || "General";
      const supplierId = edited.selectedSupplierId ?? selectedEntry?.supplierId ?? null;

      const initialsToAdd = hasExtraction && edited.extractedEntries ? collectInitialsToLearn(result, edited.extractedEntries) : [];
      if (initialsToAdd.length > 0) {
        const list = initialsToAdd.map(i => `"${i.initial}" -> "${i.supplierName}"`).join("\n");
        if (!window.confirm(`Add the following supplier initials?\n\n${list}\n\nThis will help match similar suppliers in future extractions.`)) {
          return;
        }
      }

      const source = !hasExtraction
        ? "MANUAL_INPUT"
        : selectedEntry?.editedCost != null
          ? "MANUAL_OVERRIDE"
          : "EXTRACTED_SELECTED";

      setHideProductImageForTransition(true);
      try {
        await api.approveItem({
          cutoverId,
          productId: result.productId,
          cost,
          source,
          notes: `Supplier: ${supplierName}`,
          extractedEntries: hasExtraction
            ? edited.extractedEntries.map(e => ({
                supplier: e.supplier,
                amount: e.amount,
                supplierId: e.supplierId ?? null,
                editedSupplierName: e.editedSupplierName ?? null,
                editedCost: e.editedCost ?? null,
                editedEffectiveDate: e.editedEffectiveDate ?? null,
                isSelected: e.isSelected ?? false,
              }))
            : [],
          selectedSupplierId: supplierId,
          selectedSupplierName: supplierName,
          sellingPrice: result.sellingPrice ?? null,
          sellingPriceRange: result.sellingPriceRange ?? null,
        });

        if (initialsToAdd.length > 0) {
          await Promise.all(initialsToAdd.map(i => api.addSupplierInitial(i.supplierName, i.initial).catch(() => undefined)));
          setSupplierInitialsMap(prev => {
            const next = { ...prev };
            for (const i of initialsToAdd) {
              next[i.supplierName] = (next[i.supplierName] ?? []).filter(x => x.toLowerCase() !== i.initial.toLowerCase());
              if (next[i.supplierName].length === 0) delete next[i.supplierName];
            }
            return next;
          });
          const refreshed = await api.fetchAllSuppliers();
          setAllSuppliers(refreshed);
          // Re-match remaining pending items immediately so a newly-learned
          // initial applies without waiting for the next batch load.
          setExtractionResults(prev =>
            prev.map(r =>
              r.migrationStatus === "APPROVED" || r.migrationStatus === "SKIPPED"
                ? r
                : normalizeExtractedEntries([r], refreshed, supplierNameMappings, false)[0]
            )
          );
        }

        updateItemStatus(result.productId, {
          migrationStatus: "APPROVED",
          selectedCost: cost,
          selectedSupplierName: supplierName,
          selectedSupplierId: supplierId,
        });
        setSessionItemCounts(prev => (prev ? { ...prev, approved: prev.approved + 1 } : prev));
        advanceAfterAction();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to approve item");
      } finally {
        setHideProductImageForTransition(false);
      }
    },
    [cutoverId, editedResults, collectInitialsToLearn, updateItemStatus, advanceAfterAction]
  );

  // --- Migration ---

  const pendingCount = extractionResults.filter(r => !r.migrationStatus || r.migrationStatus === "PENDING").length;

  /** Every path to starting migration now goes through a confirmation —
   * the legacy version only asked when items were still pending, meaning a
   * fully-reviewed batch could hit "Start Migration" (which locks costs for
   * the location, see CutoverLock) with zero confirmation. */
  const requestStartMigration = useCallback(() => {
    setConfirmingMigration(true);
  }, []);

  const confirmStartMigration = useCallback(async () => {
    setConfirmingMigration(false);
    setLoading(true);
    setError(null);
    setPhase("migrating");
    try {
      const result = await api.initiateCutover({
        cutoverDate: `${cutoverDate}T00:00:00Z`,
        locationIds: selectedLocationId ? [selectedLocationId] : [],
        costBasis,
        ownerApproved: true,
        // `currentCutoverId` is null until the first migration batch returns —
        // fall back to the extraction session's id (`cutoverId`), which is what
        // approve/discard/mark-discontinued actually tagged CostApproval rows
        // with during review. Sending `currentCutoverId` (always null here)
        // silently dropped every discard/discontinue from the exclusion filter.
        approvalId: cutoverId,
        batchSize,
      });
      setMigrationResult(result);
      if (result.cutoverId) setCurrentCutoverId(result.cutoverId);
      if (result.isComplete) {
        setReportData(result);
        setPhase("reporting");
      } else if (result.cutoverId) {
        await continueMigrationLoop(result.cutoverId);
      } else {
        setError("Migration initiated but cutoverId not returned. Cannot continue.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Migration failed");
      setPhase("extracting");
    } finally {
      setLoading(false);
    }
    // continueMigrationLoop intentionally omitted: it's referentially stable
    // ([] deps) and only closes over its `id` parameter, never stale state.
  }, [cutoverDate, selectedLocationId, costBasis, cutoverId, batchSize]);

  const continueMigrationLoop = useCallback(async (id: string) => {
    try {
      const result = await api.continueCutover(id);
      setMigrationResult(result);
      if (result.cutoverId && result.cutoverId !== id) setCurrentCutoverId(result.cutoverId);
      if (result.isComplete) {
        setReportData(result);
        setPhase("reporting");
      } else {
        setTimeout(() => continueMigrationLoop(result.cutoverId || id), 100);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to continue migration");
    }
  }, []);

  const groupedResults = {
    extracting: extractionResults.filter(r => r.migrationStatus !== "SKIPPED" && r.migrationStatus !== "APPROVED"),
    approved: extractionResults.filter(r => r.migrationStatus === "APPROVED"),
    discarded: extractionResults.filter(r => r.migrationStatus === "SKIPPED"),
  };

  useEffect(() => {
    if (phase !== "extracting" || loading) {
      if (loading) setBatchComplete(false);
      return;
    }
    if (extractionResults.length === 0) return setBatchComplete(false);
    const stillExtracting = extractionResults.filter(r => r.migrationStatus !== "SKIPPED" && r.migrationStatus !== "APPROVED");
    setBatchComplete(stillExtracting.length === 0);
  }, [extractionResults, phase, loading]);

  return {
    phase,
    setPhase,
    locations,
    selectedLocationId,
    setSelectedLocationId,
    cutoverDate,
    setCutoverDate,
    costBasis,
    setCostBasis,
    batchSize,
    setBatchSize,
    loading,
    error,
    setError,
    extractionResults,
    setExtractionResults,
    extractionTab,
    setExtractionTab,
    currentExtractingIndex,
    setCurrentExtractingIndex,
    editedResults,
    setEditedResults,
    allSuppliers,
    supplierNameMappings,
    setSupplierNameMappings,
    supplierInitialsMap,
    setSupplierInitialsMap,
    sessionItemCounts,
    hideProductImageForTransition,
    batchComplete,
    existingSessions,
    showSessionSelector,
    setShowSessionSelector,
    migrationResult,
    reportData,
    extractionSessionId,
    cutoverId,
    groupedResults,
    pendingCount,
    confirmingMigration,
    dropdownSelectionRef,
    getSupplierSuggestions: (input: string) => getSupplierSuggestions(input, allSuppliers, supplierNameMappings),
    findAutoSelectMatch: (input: string) => findAutoSelectMatch(input, allSuppliers, supplierNameMappings),
    handleStartExtraction,
    handleStartNewExtraction,
    handleResumeSession,
    handleContinueBatch,
    handleDiscardItem,
    handleRestoreItem,
    handleMarkDiscontinued,
    handleRegenerateExtraction,
    handleReusePreviousApprovals,
    handleApproveItem,
    requestStartMigration,
    confirmStartMigration,
    cancelStartMigration: () => setConfirmingMigration(false),
  };
}
