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
  } = wizard;

  const totalItems = groupedResults.extracting.length + groupedResults.approved.length + groupedResults.discarded.length;
  const counts = sessionItemCounts ?? {
    pending: groupedResults.extracting.length,
    approved: groupedResults.approved.length,
    skipped: groupedResults.discarded.length,
  };
  const progress = totalItems > 0 ? ((totalItems - groupedResults.extracting.length) / totalItems) * 100 : 0;

  const reusable = groupedResults.extracting.filter(
    r => r.isAlreadyApproved && r.existingApprovedCost != null && r.migrationStatus !== "APPROVED"
  );

  const onSavedReviewedItem = (productId: string, updates: Partial<(typeof groupedResults.approved)[number]>) => {
    setExtractionResults(prev => prev.map(r => (r.productId === productId ? { ...r, ...updates } : r)));
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h2 className="text-2xl font-bold text-(--color-ink)">Extraction Workspace</h2>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <div className="flex items-center justify-between gap-4 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
        <div className="flex gap-3">
          <span className="rounded-full bg-(--color-accent)/10 px-3 py-1 text-sm font-medium text-(--color-accent)">
            Total: {totalItems}
          </span>
          <span className="rounded-full bg-(--color-warning-bg) px-3 py-1 text-sm font-medium text-(--color-warning)">
            Remaining: {groupedResults.extracting.length}
          </span>
        </div>
        <div className="mx-4 h-2 flex-1 rounded-full bg-(--color-surface-inset)">
          <div className="h-full rounded-full bg-(--color-accent) transition-all" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex gap-2">
          {reusable.length > 0 && (
            <button
              onClick={handleReusePreviousApprovals}
              disabled={loading}
              className="rounded-sm bg-(--color-success) px-4 py-2 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
            >
              Reuse {reusable.length} previous approval{reusable.length !== 1 ? "s" : ""}
            </button>
          )}
          <button
            onClick={() => setPhase("configuring")}
            className="rounded-sm border border-(--color-border-standard) px-4 py-2 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
          >
            Pause & exit
          </button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-(--color-border-standard)">
        {(
          [
            ["extracting", `Extracting / action needed (${counts.pending})`],
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
            className={`border-b-2 px-5 py-3 text-sm font-medium transition-colors ${
              extractionTab === tab
                ? "border-(--color-accent) text-(--color-accent)"
                : "border-transparent text-(--color-ink-tertiary) hover:text-(--color-ink)"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {extractionTab === "extracting" && (
        <ExtractionItemEditor
          result={groupedResults.extracting[currentExtractingIndex]}
          extractingItems={groupedResults.extracting}
          currentIndex={currentExtractingIndex}
          setCurrentIndex={setCurrentExtractingIndex}
          editedResults={editedResults}
          setEditedResults={setEditedResults}
          getSupplierSuggestions={getSupplierSuggestions}
          cutoverDate={cutoverDate}
          onApprove={handleApproveItem}
          onDiscard={handleDiscardItem}
          setError={setError}
          hideProductImageForTransition={hideProductImageForTransition}
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

      {phase === "reviewing" && (
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
    </div>
  );
}
