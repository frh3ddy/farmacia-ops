import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ExtractionItemEditor } from "../components/ExtractionItemEditor";
import { ReviewedItemCard } from "../components/ReviewedItemCard";
import { SupplierInitialsPanel } from "../components/SupplierInitialsPanel";
import { BatchCompleteModal } from "../components/BatchCompleteModal";
import type { useCutoverWizard } from "../../../lib/cutover/useCutoverWizard";

type ExtractionPhaseProps = { wizard: ReturnType<typeof useCutoverWizard> };

export function ExtractionPhase({ wizard }: ExtractionPhaseProps) {
  const {
    groupedResults,
    extractionTab,
    setExtractionTab,
    currentExtractingIndex,
    setCurrentExtractingIndex,
    editedResults,
    setEditedResults,
    getSupplierSuggestions,
    cutoverDate,
    handleApproveItem,
    handleDiscardItem,
    handleMarkDiscontinued,
    handleRegenerateExtraction,
    handleRestoreItem,
    handleReusePreviousApprovals,
    handleContinueBatch,
    requestStartMigration,
    setExtractionResults,
    setError,
    error,
    loading,
    phase,
    setPhase,
    batchComplete,
    supplierInitialsMap,
    setSupplierInitialsMap,
    hideProductImageForTransition,
    cutoverId,
    sessionItemCounts,
    sessionExtractionComplete,
    sessionTotals,
    allCategories,
  } = wizard;

  // Batch-scoped: only what's currently loaded client-side (this page of
  // items), not the whole location's cutover session.
  const batchTotal = groupedResults.extracting.length + groupedResults.approved.length + groupedResults.discarded.length;
  const counts = sessionItemCounts ?? {
    pending: groupedResults.extracting.length,
    approved: groupedResults.approved.length,
    skipped: groupedResults.discarded.length,
  };
  // groupedResults.extracting always reflects live local state (approvals/discards
  // update it immediately), unlike sessionItemCounts.pending which is only as
  // fresh as the last batch fetch — so the tab uses the live count, not counts.pending.
  const pendingCount = groupedResults.extracting.length;
  const readyToMigrate = sessionExtractionComplete && pendingCount === 0;

  // Location-scoped: every item across the whole cutover session for the
  // selected location(s), including batches not yet fetched. "Processed" is
  // derived from counts.approved/skipped (recomputed from a real CostApproval
  // query on every fetch) rather than a separately-incremented counter, which
  // drifted out of sync in practice.
  const locationProcessed = counts.approved + counts.skipped;
  const locationTotal = sessionTotals?.totalItems ?? null;
  const locationRemaining = sessionTotals ? Math.max(0, sessionTotals.totalItems - locationProcessed) : null;

  const progress =
    sessionTotals && sessionTotals.totalItems > 0
      ? (locationProcessed / sessionTotals.totalItems) * 100
      : batchTotal > 0
        ? ((batchTotal - pendingCount) / batchTotal) * 100
        : 0;

  const reusable = groupedResults.extracting.filter(
    r => r.isAlreadyApproved && r.existingApprovedCost != null && r.migrationStatus !== "APPROVED"
  );

  const onSavedReviewedItem = (productId: string, updates: Partial<(typeof groupedResults.approved)[number]>) => {
    setExtractionResults(prev => prev.map(r => (r.productId === productId ? { ...r, ...updates } : r)));
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <div className="rounded-md border border-(--color-border-standard) bg-(--color-surface-raised)">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <div className="flex gap-2">
            <span className="rounded-full bg-(--color-accent)/10 px-2.5 py-0.5 text-xs font-medium text-(--color-accent)">
              Batch total: {batchTotal}
            </span>
            <span className="rounded-full bg-(--color-warning-bg) px-2.5 py-0.5 text-xs font-medium text-(--color-warning)">
              Batch remaining: {pendingCount}
            </span>
          </div>
          <div className="h-4 w-px shrink-0 bg-(--color-border-standard)" />
          {locationTotal != null && (
            <div className="flex gap-2">
              <span className="rounded-full border border-(--color-border-standard) px-2.5 py-0.5 text-xs font-medium text-(--color-ink-secondary)">
                Location total: {locationTotal}
              </span>
              <span className="rounded-full border border-(--color-border-standard) px-2.5 py-0.5 text-xs font-medium text-(--color-ink-secondary)">
                Location remaining: {locationRemaining}
              </span>
            </div>
          )}
          <div className="h-1.5 min-w-24 flex-1 rounded-full bg-(--color-surface-inset)">
            <div className="h-full rounded-full bg-(--color-accent) transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="flex gap-2">
            {reusable.length > 0 && (
              <button
                onClick={handleReusePreviousApprovals}
                disabled={loading}
                className="rounded-sm bg-(--color-success) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
              >
                Reuse {reusable.length} previous approval{reusable.length !== 1 ? "s" : ""}
              </button>
            )}
            <button
              onClick={() => setPhase("configuring")}
              className="rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
            >
              Pause & exit
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-(--color-border-standard) px-2">
          <div className="flex gap-1">
            {(
              [
                ["extracting", `Extracting`],
                ["approved", `Approved (${counts.approved})`],
                ["discarded", `Discarded (${counts.skipped})`],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => {
                  setExtractionTab(tab);
                  if (tab === "extracting") setCurrentExtractingIndex(0);
                }}
                className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  extractionTab === tab
                    ? "border-(--color-accent) text-(--color-accent)"
                    : "border-transparent text-(--color-ink-tertiary) hover:text-(--color-ink)"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {extractionTab === "extracting" && pendingCount > 0 && (
            <div className="flex items-center gap-2 py-1.5">
              <button
                onClick={() => setCurrentExtractingIndex(prev => Math.max(0, prev - 1))}
                disabled={currentExtractingIndex === 0}
                className="rounded-sm bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-contrast) disabled:cursor-not-allowed disabled:opacity-40"
              >
                ← Previous
              </button>
              <span className="whitespace-nowrap text-xs font-medium text-(--color-ink-secondary)">
                Item {currentExtractingIndex + 1} of {pendingCount}
              </span>
              <button
                onClick={() => setCurrentExtractingIndex(prev => Math.min(pendingCount - 1, prev + 1))}
                disabled={currentExtractingIndex >= pendingCount - 1}
                className="rounded-sm bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-contrast) disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}
        </div>
      </div>

      {extractionTab === "extracting" && (
        <ExtractionItemEditor
          result={groupedResults.extracting[currentExtractingIndex]}
          extractingItems={groupedResults.extracting}
          currentIndex={currentExtractingIndex}
          editedResults={editedResults}
          setEditedResults={setEditedResults}
          getSupplierSuggestions={getSupplierSuggestions}
          cutoverDate={cutoverDate}
          onApprove={handleApproveItem}
          onDiscard={handleDiscardItem}
          onMarkDiscontinued={handleMarkDiscontinued}
          onRegenerateExtraction={handleRegenerateExtraction}
          setError={setError}
          hideProductImageForTransition={hideProductImageForTransition}
          allCategories={allCategories}
        />
      )}

      {extractionTab === "approved" && (
        <div className="space-y-4">
          {groupedResults.approved.map(result => (
            <ReviewedItemCard
              key={result.productId}
              result={result}
              variant="approved"
              cutoverId={cutoverId}
              getSupplierSuggestions={getSupplierSuggestions}
              onSaved={onSavedReviewedItem}
              setError={setError}
            />
          ))}
        </div>
      )}

      {extractionTab === "discarded" && (
        <div className="space-y-4">
          {groupedResults.discarded.map(result => (
            <ReviewedItemCard
              key={result.productId}
              result={result}
              variant="skipped"
              cutoverId={cutoverId}
              getSupplierSuggestions={getSupplierSuggestions}
              onSaved={onSavedReviewedItem}
              onRestore={handleRestoreItem}
              setError={setError}
            />
          ))}
        </div>
      )}

      <SupplierInitialsPanel
        supplierInitialsMap={supplierInitialsMap}
        onClear={() => setSupplierInitialsMap({})}
        onRemove={name =>
          setSupplierInitialsMap(prev => {
            const next = { ...prev };
            delete next[name];
            return next;
          })
        }
      />

      <BatchCompleteModal
        show={batchComplete}
        loading={loading}
        onContinue={handleContinueBatch}
        onReview={() => setPhase("reviewing")}
        onPause={() => setPhase("configuring")}
      />

      {phase === "reviewing" && readyToMigrate && (
        <div className="flex justify-end">
          <button
            onClick={requestStartMigration}
            disabled={loading}
            className="rounded-sm bg-(--color-success) px-6 py-2 font-medium text-(--color-accent-contrast) disabled:opacity-50"
          >
            {loading ? "Starting migration…" : "Start migration"}
          </button>
        </div>
      )}

      {/* The currently loaded batch is drained, but more batches remain unfetched
          — surface a way forward instead of leaving Start migration hidden with
          no visible next step. */}
      {phase === "reviewing" && !readyToMigrate && !sessionExtractionComplete && (
        <div className="flex justify-end">
          <button
            onClick={handleContinueBatch}
            disabled={loading}
            className="rounded-sm bg-(--color-accent) px-6 py-2 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
          >
            {loading ? "Loading…" : "Continue extraction"}
          </button>
        </div>
      )}
    </div>
  );
}
