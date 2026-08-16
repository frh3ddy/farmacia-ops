import { useState } from "react";
import * as api from "../../../lib/cutover/api";
import { ApiError } from "../../../lib/apiFetch";
import { SupplierAutocompleteInput } from "./SupplierAutocompleteInput";
import type { CostExtractionResult, CutoverError, SupplierSuggestion } from "../../../lib/cutover/types";

type ReviewedItemCardProps = {
  result: CostExtractionResult;
  variant: "approved" | "skipped";
  cutoverId: string | null;
  getSupplierSuggestions: (input: string) => SupplierSuggestion[];
  onSaved: (productId: string, updates: Partial<CostExtractionResult>) => void;
  setError: (error: CutoverError | null) => void;
};

/**
 * Replaces ApprovedItemEditor.jsx and SkippedItemEditor.jsx — ~90%
 * identical (same cost/supplier inline edit, same autocomplete, same
 * approve-item call), differing only in status label, dim/grayscale
 * treatment, and button label ("Save" vs "Approve"). One card, one variant
 * prop. Inline edits here call approve-item directly and don't run the
 * initials-learning flow — that's specific to the primary extraction
 * workspace review (handleApproveItem), matching the legacy split.
 */
export function ReviewedItemCard({ result, variant, cutoverId, getSupplierSuggestions, onSaved, setError }: ReviewedItemCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [cost, setCost] = useState(() => String(result.selectedCost ?? ""));
  const [supplierName, setSupplierName] = useState(result.selectedSupplierName ?? "");
  const [supplierId, setSupplierId] = useState(result.selectedSupplierId ?? null);
  const [saving, setSaving] = useState(false);

  const isApproved = variant === "approved";

  const startEdit = () => {
    setCost(String(result.selectedCost ?? ""));
    setSupplierName(result.selectedSupplierName ?? "");
    setSupplierId(result.selectedSupplierId ?? null);
    setIsEditing(true);
  };

  const handleSave = async () => {
    const numericCost = parseFloat(cost) || 0;
    if (!numericCost || numericCost <= 0) return setError("Please enter a valid cost");
    if (!supplierName) return setError("Please enter a supplier name");
    if (!cutoverId) return setError("Missing cutover ID");

    setSaving(true);
    try {
      await api.approveItem({
        cutoverId,
        productId: result.productId,
        cost: numericCost,
        source: "MANUAL_OVERRIDE",
        notes: `Supplier: ${supplierName}`,
        extractedEntries: result.extractedEntries ?? [],
        selectedSupplierId: supplierId,
        selectedSupplierName: supplierName,
      });
      onSaved(result.productId, {
        migrationStatus: "APPROVED",
        selectedCost: numericCost,
        selectedSupplierName: supplierName,
        selectedSupplierId: supplierId,
      });
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to ${isApproved ? "update" : "approve"} item`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`rounded-md border border-(--color-border-standard) p-4 ${
        isApproved || isEditing ? "bg-(--color-surface)" : "bg-(--color-surface) opacity-60"
      }`}
    >
      <div className="flex items-start gap-4">
        {result.imageUrl && (
          <img
            src={result.imageUrl}
            alt={result.productName}
            className={`h-20 w-20 rounded object-cover ${isApproved || isEditing ? "" : "grayscale"}`}
          />
        )}
        <div className="flex-1 space-y-3">
          <div>
            <h3 className="font-semibold text-(--color-ink)">{result.productName}</h3>
            <p className="text-sm">
              Status:{" "}
              <span className={isApproved ? "font-medium text-(--color-success)" : "font-medium text-(--color-destructive)"}>
                {isApproved ? "Approved" : "Discarded"}
              </span>
            </p>
          </div>

          {result.sellingPrice && (
            <div>
              <label className="text-xs font-medium text-(--color-ink-tertiary)">Selling price</label>
              <p className="mt-0.5 tabular text-sm font-semibold text-(--color-ink)">${(result.sellingPrice.priceCents / 100).toFixed(2)}</p>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-(--color-ink-tertiary)">Cost</label>
            {isEditing ? (
              <input
                type="number"
                step="0.01"
                min="0"
                value={cost}
                onChange={e => setCost(e.target.value)}
                className="mt-1 w-full rounded-sm border border-(--color-border-standard) px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent)"
              />
            ) : (
              <p className="tabular mt-0.5 text-sm text-(--color-ink)">
                {result.selectedCost != null ? `$${result.selectedCost.toFixed(2)}` : "Not specified"}
              </p>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-(--color-ink-tertiary)">Supplier</label>
            {isEditing ? (
              <div className="mt-1">
                <SupplierAutocompleteInput
                  value={supplierName}
                  onChange={setSupplierName}
                  onSelectSuggestion={s => {
                    setSupplierName(s.name);
                    setSupplierId(s.id);
                  }}
                  getLocalSuggestions={getSupplierSuggestions}
                />
              </div>
            ) : (
              <p className="mt-0.5 text-sm text-(--color-ink)">{result.selectedSupplierName || "Not specified"}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {isEditing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-sm bg-(--color-success) px-3 py-1 text-sm text-(--color-accent-contrast) disabled:opacity-50"
              >
                {saving ? "Saving…" : isApproved ? "Save" : "Approve"}
              </button>
              <button
                onClick={() => setIsEditing(false)}
                disabled={saving}
                className="rounded-sm border border-(--color-border-standard) px-3 py-1 text-sm text-(--color-ink-secondary)"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={startEdit}
              className={`rounded-sm px-3 py-1 text-sm ${
                isApproved
                  ? "border border-(--color-border-standard) text-(--color-ink-secondary)"
                  : "bg-(--color-accent) text-(--color-accent-contrast)"
              }`}
            >
              Edit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
