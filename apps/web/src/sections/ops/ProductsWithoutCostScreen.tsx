import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";

type ProductWithoutCost = { id: string; name: string; sku: string | null };
type LocationStock = { locationId: string; locationName: string; quantity: number };

/**
 * Products synced from Square after the cutover that never got a cost (no
 * inventory batches). Saving records Square's current on-hand count as a
 * FOUND batch at the entered cost — syncToSquare: false, because those units
 * are already counted in Square.
 */
export function ProductsWithoutCostScreen() {
  const [products, setProducts] = useState<ProductWithoutCost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ data: ProductWithoutCost[] }>("/products/without-cost")
      .then(body => setProducts(body.data))
      .catch(err => setError(err instanceof ApiError ? err.message : "Failed to load products"));
  }, []);

  if (error) return <p className="text-sm text-(--color-destructive)">{error}</p>;
  if (!products) return <p className="text-sm text-(--color-ink-tertiary)">Loading…</p>;

  const remove = (id: string) => {
    setProducts(products.filter(p => p.id !== id));
    setOpenId(null);
  };

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold text-(--color-ink)">Products without cost ({products.length})</h1>
      <p className="mb-4 text-sm text-(--color-ink-secondary)">
        Synced from Square but never costed. Saving records Square's current stock at the cost you enter.
      </p>
      {products.length === 0 ? (
        <p className="text-sm text-(--color-ink-tertiary)">Every Square product has a cost.</p>
      ) : (
        <ul className="divide-y divide-(--color-border-standard) rounded-md border border-(--color-border-standard) bg-(--color-surface-raised)">
          {products.map(p => (
            <li key={p.id} className="p-3">
              <button
                onClick={() => setOpenId(openId === p.id ? null : p.id)}
                className="flex w-full items-center justify-between text-left text-sm"
              >
                <span className="font-medium text-(--color-ink)">{p.name}</span>
                <span className="text-(--color-ink-tertiary)">{p.sku ?? "—"}</span>
              </button>
              {openId === p.id && <CostForm product={p} onSaved={() => remove(p.id)} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CostForm({ product, onSaved }: { product: ProductWithoutCost; onSaved: () => void }) {
  const [stock, setStock] = useState<(LocationStock & { requestId: string })[] | null>(null);
  const [unitCost, setUnitCost] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ locations: LocationStock[] }>(
      `/admin/inventory/cutover/stock-by-location?productId=${encodeURIComponent(product.id)}`,
    )
      // One dedup key per location, fixed for this form: retrying after a
      // partial failure replays the saved locations instead of adding twice.
      .then(body => setStock(body.locations.map(l => ({ ...l, requestId: crypto.randomUUID() }))))
      .catch(err => setError(err instanceof ApiError ? err.message : "Failed to load Square stock"));
  }, [product.id]);

  if (!stock) return error ? <p className="mt-2 text-sm text-(--color-destructive)">{error}</p> : (
    <p className="mt-2 text-sm text-(--color-ink-tertiary)">Loading Square stock…</p>
  );

  const stocked = stock.filter(l => l.quantity > 0);
  const cost = Number(unitCost);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const l of stocked) {
        await apiFetch("/inventory/adjustments", {
          method: "POST",
          body: JSON.stringify({
            locationId: l.locationId,
            productId: product.id,
            type: "FOUND",
            quantity: l.quantity,
            unitCost: cost,
            reason: "Initial cost for product added in Square after cutover",
            syncToSquare: false,
            clientRequestId: l.requestId,
          }),
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save cost");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      <ul className="text-sm text-(--color-ink-secondary)">
        {stock.map(l => (
          <li key={l.locationId}>
            {l.locationName}: {l.quantity} in Square
          </li>
        ))}
      </ul>
      {stocked.length === 0 ? (
        <p className="text-sm text-(--color-ink-tertiary)">
          No stock in Square — record the cost with receiving when it arrives.
        </p>
      ) : (
        <div className="flex items-end gap-2">
          <label className="text-sm text-(--color-ink-secondary)">
            Unit cost
            <input
              type="number"
              min="0"
              step="0.01"
              value={unitCost}
              onChange={e => setUnitCost(e.target.value)}
              className="mt-1 block w-32 rounded-sm border border-(--color-border-standard) px-2 py-1"
            />
          </label>
          <button
            onClick={save}
            disabled={saving || !unitCost || cost <= 0}
            className="rounded-sm bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
      {error && <p className="text-sm text-(--color-destructive)">{error}</p>}
    </div>
  );
}
