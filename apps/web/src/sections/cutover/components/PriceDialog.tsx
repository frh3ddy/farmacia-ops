import { useEffect, useState } from "react";
import { Modal } from "../../../components/ui/Modal";
import { getPriceByLocation, type LocationPrice } from "../../../lib/cutover/api";
import { ApiError } from "../../../lib/apiFetch";

type PriceDialogProps = {
  open: boolean;
  productId: string;
  productName: string;
  /** Resolves false on failure (the caller surfaces the error) — the dialog then stays open. */
  onConfirm: (priceCents: number, currency: string, locationIds: string[]) => Promise<boolean>;
  onClose: () => void;
};

const formatCents = (cents: number | null) => (cents == null ? "—" : `$${(cents / 100).toFixed(2)}`);

/**
 * Edits a product's Square selling price. Mirrors ZeroStockDialog: each
 * location's live price is shown next to what it becomes, and every
 * location starts checked.
 */
export function PriceDialog({ open, productId, productName, onConfirm, onClose }: PriceDialogProps) {
  const [data, setData] = useState<{ variationCount: number; currency: string | null; locations: LocationPrice[] } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [price, setPrice] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setData(null);
    setLoadError(null);
    setPrice("");
    getPriceByLocation(productId)
      .then(res => {
        if (cancelled) return;
        setData(res);
        setChecked(new Set(res.locations.map(l => l.locationId)));
      })
      .catch(err => !cancelled && setLoadError(err instanceof ApiError ? err.message : "Failed to load prices"));
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

  const priceCents = Math.round(parseFloat(price) * 100);
  const validPrice = Number.isFinite(priceCents) && priceCents > 0;
  const editable = data && data.variationCount === 1 && data.currency;

  const handleConfirm = async () => {
    if (!editable || !validPrice) return;
    setSaving(true);
    try {
      if (await onConfirm(priceCents, data.currency!, [...checked])) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit selling price"
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
            disabled={!editable || !validPrice || checked.size === 0 || saving}
            className="rounded-sm bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Updating…" : "Update in Square"}
          </button>
        </>
      }
    >
      <p className="text-sm text-(--color-ink-secondary)">Sets the Square selling price for "{productName}" at the checked locations.</p>
      {loadError ? (
        <p className="mt-4 text-sm text-(--color-destructive)">{loadError}</p>
      ) : !data ? (
        <p className="mt-4 text-sm text-(--color-ink-tertiary)">Loading current prices…</p>
      ) : data.variationCount !== 1 ? (
        <p className="mt-4 text-sm text-(--color-warning)">
          This product has {data.variationCount} Square variations — edit its prices in Square.
        </p>
      ) : !data.currency ? (
        <p className="mt-4 text-sm text-(--color-warning)">This product has no price in Square yet — set one in Square first.</p>
      ) : (
        <>
          <label htmlFor="price-dialog-input" className="mt-4 block text-xs font-medium text-(--color-ink-tertiary)">
            New price ({data.currency})
          </label>
          <input
            id="price-dialog-input"
            autoFocus
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={e => setPrice(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleConfirm()}
            className="mt-1 w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-1.5 text-sm tabular text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
          />
          <div className="mt-4 space-y-1.5">
            {data.locations.map(loc => (
              <label
                key={loc.locationId}
                className="flex cursor-pointer items-center justify-between rounded-sm border border-(--color-border-standard) px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked.has(loc.locationId)}
                    onChange={() => toggle(loc.locationId)}
                    className="h-4 w-4 accent-(--color-accent)"
                  />
                  {loc.locationName}
                </span>
                <span className="tabular text-(--color-ink-tertiary)">
                  {formatCents(loc.priceCents)} → {checked.has(loc.locationId) && validPrice ? formatCents(priceCents) : formatCents(loc.priceCents)}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
