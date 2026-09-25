import { useEffect, useState } from "react";
import { Modal } from "../../../components/ui/Modal";
import { getStockByLocation, type LocationStock } from "../../../lib/cutover/api";
import { ApiError } from "../../../lib/apiFetch";

type ZeroStockDialogProps = {
  open: boolean;
  productId: string;
  productName: string;
  /** Resolves false on failure (the caller surfaces the error) — the dialog then stays open. */
  onConfirm: (locationIds: string[]) => Promise<boolean>;
  onClose: () => void;
};

/**
 * Sets a product's Square stock to 0 at the checked locations. Shows each
 * location's live count first, so the reviewer sees exactly what they're
 * overwriting — every location starts checked, since the owner usually
 * knows an item is out everywhere.
 */
export function ZeroStockDialog({ open, productId, productName, onConfirm, onClose }: ZeroStockDialogProps) {
  const [locations, setLocations] = useState<LocationStock[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLocations(null);
    setLoadError(null);
    getStockByLocation(productId)
      .then(locs => {
        if (cancelled) return;
        setLocations(locs);
        setChecked(new Set(locs.map(l => l.locationId)));
      })
      .catch(err => !cancelled && setLoadError(err instanceof ApiError ? err.message : "Failed to load stock"));
    return () => {
      cancelled = true;
    };
  }, [open, productId]);

  const toggle = (locationId: string) =>
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(locationId)) next.delete(locationId);
      else next.add(locationId);
      return next;
    });

  const handleConfirm = async () => {
    setSaving(true);
    try {
      if (await onConfirm([...checked])) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mark as 0 stock?"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!locations || checked.size === 0 || saving}
            className="rounded-sm bg-(--color-destructive) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Updating…" : "Set to 0 in Square"}
          </button>
        </>
      }
    >
      <p className="text-sm text-(--color-ink-secondary)">
        Sets Square's count for "{productName}" to 0 at the checked locations. The migration reads this count, so it
        starts at 0 stock.
      </p>
      <div className="mt-4 space-y-1.5">
        {loadError ? (
          <p className="text-sm text-(--color-destructive)">{loadError}</p>
        ) : !locations ? (
          <p className="text-sm text-(--color-ink-tertiary)">Loading current stock…</p>
        ) : (
          locations.map(loc => (
            <label
              key={loc.locationId}
              className="flex cursor-pointer items-center justify-between rounded-sm border border-(--color-border-standard) px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked.has(loc.locationId)}
                  onChange={() => toggle(loc.locationId)}
                  className="h-4 w-4 accent-(--color-destructive)"
                />
                {loc.locationName}
              </span>
              <span className="tabular text-(--color-ink-tertiary)">
                {loc.quantity} → {checked.has(loc.locationId) ? 0 : loc.quantity}
              </span>
            </label>
          ))
        )}
      </div>
    </Modal>
  );
}
