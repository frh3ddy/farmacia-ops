import { useEffect, useMemo, useState } from "react";
import { SupplierAutocompleteInput } from "./SupplierAutocompleteInput";
import type { CostExtractionResult, ExtractedCostEntry, SupplierSuggestion } from "../../../lib/cutover/types";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function computeExtractedDate(entry: ExtractedCostEntry, cutoverDate: string): string | null {
  if (!entry.month) return null;
  const monthIndex = MONTH_NAMES.indexOf(entry.month);
  if (monthIndex === -1) return null;

  const yearMatch = entry.originalLine?.match(/\b(19|20)\d{2}\b/);
  let year = yearMatch ? parseInt(yearMatch[0]) : cutoverDate ? new Date(cutoverDate).getFullYear() : new Date().getFullYear();

  const day = entry.day ?? 1;
  const dayInMonth = (y: number) => new Date(y, monthIndex + 1, 0).getDate();
  let date = new Date(year, monthIndex, Math.min(day, dayInMonth(year)));

  const today = new Date();
  while (date > today) {
    year--;
    date = new Date(year, monthIndex, Math.min(day, dayInMonth(year)));
  }
  return date.toISOString().split("T")[0];
}

type ExtractionItemEditorProps = {
  result: CostExtractionResult | undefined;
  extractingItems: CostExtractionResult[];
  currentIndex: number;
  setCurrentIndex: (updater: (prev: number) => number) => void;
  editedResults: Record<string, CostExtractionResult>;
  setEditedResults: React.Dispatch<React.SetStateAction<Record<string, CostExtractionResult>>>;
  getSupplierSuggestions: (input: string) => SupplierSuggestion[];
  cutoverDate: string;
  onApprove: (result: CostExtractionResult) => void;
  onDiscard: (productId: string) => void;
  setError: (message: string) => void;
  hideProductImageForTransition: boolean;
};

export function ExtractionItemEditor({
  result,
  extractingItems,
  currentIndex,
  setCurrentIndex,
  editedResults,
  setEditedResults,
  getSupplierSuggestions,
  cutoverDate,
  onApprove,
  onDiscard,
  setError,
  hideProductImageForTransition,
}: ExtractionItemEditorProps) {
  const [showPriceDetails, setShowPriceDetails] = useState(false);
  // Raw text of whichever cost field is currently focused. A controlled
  // number input snaps back to its last committed value on every re-render,
  // so an in-progress edit (e.g. deleting down to "") needs to be tracked
  // separately from the committed numeric value until blur.
  const [costDraft, setCostDraft] = useState<{ idx: number | null; raw: string } | null>(null);
  const extractingCount = extractingItems.length;

  // Preload the next 10 product images so Next navigation feels instant.
  useEffect(() => {
    const upcoming = extractingItems.slice(currentIndex + 1, currentIndex + 11);
    for (const item of upcoming) {
      if (item.imageUrl) new Image().src = item.imageUrl;
    }
  }, [extractingItems, currentIndex]);

  const edited = result ? (editedResults[result.productId] ?? result) : null;
  const { displayCost, displaySupplier } = useMemo(() => {
    if (!edited) return { selectedEntry: null, displayCost: null, displaySupplier: "" };
    const entries = edited.extractedEntries ?? [];
    const last = entries.length > 0 ? entries[entries.length - 1] : null;
    const displayCost = edited.selectedCost ?? (last ? (last.editedCost ?? last.amount) : null);
    const displaySupplier = edited.selectedSupplierName || (last ? last.editedSupplierName || last.supplier : null) || "";
    return { selectedEntry: last, displayCost, displaySupplier };
  }, [edited]);

  if (!result || !edited) {
    return <p className="py-8 text-center text-sm text-(--color-ink-tertiary)">No items need action</p>;
  }

  const hasExtraction = (edited.extractedEntries?.length ?? 0) > 0;

  const updateEntry = (idx: number, patch: Partial<ExtractedCostEntry>) => {
    setEditedResults(prev => {
      const base = prev[result.productId] ?? result;
      const entries = [...(base.extractedEntries ?? result.extractedEntries ?? [])];
      entries[idx] = { ...entries[idx], ...patch };
      const isLast = idx === entries.length - 1;
      const next: CostExtractionResult = { ...base, extractedEntries: entries };
      if (isLast) {
        if ("editedSupplierName" in patch) next.selectedSupplierName = patch.editedSupplierName ?? null;
        if ("supplierId" in patch) next.selectedSupplierId = patch.supplierId ?? null;
        if ("editedCost" in patch) next.selectedCost = patch.editedCost ?? null;
      }
      return { ...prev, [result.productId]: next };
    });
  };

  const updateManualField = (patch: Partial<CostExtractionResult>) => {
    setEditedResults(prev => ({ ...prev, [result.productId]: { ...(prev[result.productId] ?? result), ...patch } }));
  };

  const handleCostChange = (idx: number | null, rawValue: string) => {
    setCostDraft({ idx, raw: rawValue });
    if (rawValue === "") return;
    const newCost = parseFloat(rawValue) || 0;
    if (idx === null) updateManualField({ selectedCost: newCost });
    else updateEntry(idx, { editedCost: newCost });
  };

  const handleCostBlur = (idx: number | null, e: React.FocusEvent<HTMLInputElement>) => {
    const newCost = parseFloat(e.target.value) || 0;
    if (newCost < 0) return setError("Cost cannot be negative");
    if (newCost === 0 && !window.confirm("Cost is zero. Are you sure?")) {
      e.target.focus();
      return; // keep the draft so the refocused field still shows what they typed
    }
    if (idx === null) updateManualField({ selectedCost: newCost });
    else updateEntry(idx, { editedCost: newCost });
    setCostDraft(null);
  };

  const priceGuardWarning = (() => {
    const minCents = result.sellingPrice?.priceCents;
    if (minCents == null || displayCost == null) return result.priceGuard?.isCostTooHigh ? result.priceGuard.message : null;
    const costCents = Math.round(displayCost * 100);
    return costCents >= minCents ? `Cost ($${displayCost.toFixed(2)}) is ≥ min selling price ($${(minCents / 100).toFixed(2)})` : null;
  })();

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-(--color-border-standard) bg-(--color-surface-raised)">
        <div className="grid grid-cols-3 gap-6 p-6">
          {/* Left: extracted costs table / manual input */}
          <div className="col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-(--color-ink)">Extracted costs</h3>
                <p className="text-sm text-(--color-ink-tertiary)">Select the most accurate cost entry below.</p>
              </div>
              {hasExtraction && (
                <span className="rounded-full bg-(--color-accent)/10 px-3 py-1 text-sm font-medium text-(--color-accent)">
                  {edited.extractedEntries!.length} found
                </span>
              )}
            </div>
            <div>
              <h3 className="text-lg font-semibold text-(--color-ink)">{result.productName}</h3>
              {result.originalDescription && result.originalDescription !== result.productName && (
                <p className="mt-1 text-sm text-(--color-ink-tertiary)">{result.originalDescription}</p>
              )}
            </div>

            {hasExtraction ? (
              <div className="overflow-hidden rounded-md border border-(--color-border-standard)">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-(--color-surface) text-xs uppercase text-(--color-ink-tertiary)">
                      <th className="px-4 py-2 text-left">Supplier</th>
                      <th className="px-4 py-2 text-left">Cost</th>
                      <th className="px-4 py-2 text-left">Date</th>
                      <th className="px-4 py-2 text-left">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {edited.extractedEntries!.map((entry, idx) => {
                      const isLast = idx === edited.extractedEntries!.length - 1;
                      const displayDate =
                        entry.editedEffectiveDate || computeExtractedDate(entry, cutoverDate) || cutoverDate || new Date().toISOString().split("T")[0];
                      return (
                        <tr key={idx} className={isLast ? "bg-(--color-accent)/5" : "border-t border-(--color-border-subtle)"}>
                          <td className="px-4 py-2">
                            <SupplierAutocompleteInput
                              value={entry.editedSupplierName ?? entry.supplier ?? ""}
                              onChange={v => updateEntry(idx, { editedSupplierName: v })}
                              onSelectSuggestion={s => updateEntry(idx, { editedSupplierName: s.name, supplierId: s.id ?? undefined })}
                              getLocalSuggestions={getSupplierSuggestions}
                              highlighted={isLast}
                              matchedByInitialLabel={entry.matchedByInitial ? entry.supplier : null}
                            />
                          </td>
                          <td className="px-4 py-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={costDraft?.idx === idx ? costDraft.raw : (entry.editedCost ?? entry.amount)}
                              onChange={e => handleCostChange(idx, e.target.value)}
                              onBlur={e => handleCostBlur(idx, e)}
                              className={`w-full rounded-sm border px-2 py-1 text-sm tabular focus:outline-none focus:ring-2 focus:ring-(--color-accent) ${
                                isLast ? "border-(--color-accent) bg-(--color-accent)/5" : "border-(--color-border-standard)"
                              }`}
                            />
                          </td>
                          <td className="px-4 py-2">
                            <input
                              type="date"
                              value={displayDate}
                              onChange={e => updateEntry(idx, { editedEffectiveDate: e.target.value })}
                              className={`w-full rounded-sm border px-2 py-1 text-sm tabular focus:outline-none focus:ring-2 focus:ring-(--color-accent) ${
                                isLast ? "border-(--color-accent) bg-(--color-accent)/5" : "border-(--color-border-standard)"
                              }`}
                            />
                          </td>
                          <td className="px-4 py-2 text-(--color-ink-tertiary)">{entry.originalLine || `$${entry.amount.toFixed(2)}`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="space-y-3 rounded-lg border border-(--color-destructive) bg-(--color-destructive-bg) p-4">
                <p className="text-sm font-medium text-(--color-destructive)">No cost extracted — manual input required</p>
                <div>
                  <label className="mb-1 block text-xs text-(--color-ink-secondary)">Supplier name *</label>
                  <SupplierAutocompleteInput
                    value={edited.selectedSupplierName ?? ""}
                    onChange={v => updateManualField({ selectedSupplierName: v })}
                    onSelectSuggestion={s => updateManualField({ selectedSupplierName: s.name, selectedSupplierId: s.id })}
                    getLocalSuggestions={getSupplierSuggestions}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-(--color-ink-secondary)">Cost *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={costDraft?.idx === null ? costDraft.raw : (edited.selectedCost ?? "")}
                    onChange={e => handleCostChange(null, e.target.value)}
                    onBlur={e => handleCostBlur(null, e)}
                    placeholder="Enter cost"
                    className="w-full rounded-sm border border-(--color-border-standard) px-3 py-2 text-sm tabular focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Right: product review */}
          <div className="space-y-4">
            <div>
              <h4 className="text-base font-semibold text-(--color-ink)">{result.productName}</h4>
              <div className="mt-4 flex min-h-[200px] items-center justify-center rounded-lg bg-(--color-surface-inset) p-8">
                {result.imageUrl && !hideProductImageForTransition ? (
                  <img src={result.imageUrl} alt={result.productName} className="max-h-48 max-w-full object-contain" />
                ) : (
                  <span className="text-sm text-(--color-ink-muted)">
                    {hideProductImageForTransition ? "Loading next product…" : "No image available"}
                  </span>
                )}
              </div>
            </div>

            {result.sellingPrice && (
              <div className="rounded-md border border-(--color-border-standard) bg-(--color-accent)/5 p-4">
                <h5 className="mb-2 text-xs font-semibold uppercase text-(--color-ink-tertiary)">Selling price</h5>
                {result.sellingPriceRange && result.sellingPriceRange.minCents !== result.sellingPriceRange.maxCents ? (
                  <div>
                    <div className="tabular mb-2 text-lg font-bold text-(--color-ink)">
                      ${(result.sellingPrice.priceCents / 100).toFixed(2)} – ${(result.sellingPriceRange.maxCents / 100).toFixed(2)}
                    </div>
                    {result.sellingPrices && result.sellingPrices.length > 1 && (
                      <div>
                        <button
                          onClick={() => setShowPriceDetails(v => !v)}
                          className="text-sm font-medium text-(--color-accent) hover:text-(--color-accent-hover)"
                        >
                          {showPriceDetails ? "Hide" : "Show"} details
                        </button>
                        {showPriceDetails && (
                          <div className="mt-2 space-y-1">
                            {result.sellingPrices.map((price, idx) => (
                              <div
                                key={idx}
                                className="flex items-center justify-between rounded-sm border border-(--color-border-subtle) bg-(--color-surface-raised) px-2 py-1 text-sm"
                              >
                                <span className="font-medium">{price.variationName || `Variation ${idx + 1}`}</span>
                                <span className="tabular">${(price.priceCents / 100).toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="tabular text-lg font-bold text-(--color-ink)">${(result.sellingPrice.priceCents / 100).toFixed(2)}</div>
                )}
              </div>
            )}

            <div className="rounded-md border border-(--color-border-standard) bg-(--color-surface-inset) p-4">
              <div className="space-y-1 text-sm">
                <div>
                  <span className="text-(--color-ink-tertiary)">Supplier:</span>{" "}
                  <span className="font-medium text-(--color-ink)">{displaySupplier || "Not selected"}</span>
                </div>
                <div>
                  <span className="text-(--color-ink-tertiary)">Cost:</span>{" "}
                  <span className="tabular text-lg font-bold text-(--color-ink)">${displayCost != null ? displayCost.toFixed(2) : "0.00"}</span>
                </div>
              </div>
              {priceGuardWarning && (
                <div className="mt-3 rounded-sm border border-(--color-destructive) bg-(--color-destructive-bg) px-3 py-2 text-sm text-(--color-destructive)">
                  {priceGuardWarning}
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => onApprove(edited)}
                className="flex-1 rounded-sm bg-(--color-success) py-2 text-sm font-medium text-(--color-accent-contrast)"
              >
                Approve
              </button>
              <button
                onClick={() => onDiscard(result.productId)}
                className="flex-1 rounded-sm border border-(--color-destructive) py-2 text-sm font-medium text-(--color-destructive) hover:bg-(--color-destructive-bg)"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      </div>

      {extractingCount > 0 && (
        <div className="flex items-center gap-4 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-3">
          <button
            onClick={() => setCurrentIndex(prev => Math.max(0, prev - 1))}
            disabled={currentIndex === 0}
            className="rounded-sm bg-(--color-accent) px-4 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:cursor-not-allowed disabled:opacity-40"
          >
            ← Previous
          </button>
          <span className="text-sm font-medium text-(--color-ink-secondary)">
            Item {currentIndex + 1} of {extractingCount}
          </span>
          <button
            onClick={() => setCurrentIndex(prev => Math.min(extractingCount - 1, prev + 1))}
            disabled={currentIndex >= extractingCount - 1}
            className="rounded-sm bg-(--color-accent) px-4 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
