import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../../lib/apiFetch";
import { useSuppliers } from "../../../lib/ops/useSuppliers";
import type { CostHistoryEntry, SupplierProductRow } from "../../../lib/ops/types";

export function SupplierCostHistory() {
  const { suppliers } = useSuppliers();
  const [selectedSupplier, setSelectedSupplier] = useState("");
  const [selectedProduct, setSelectedProduct] = useState("");
  const [products, setProducts] = useState<SupplierProductRow[]>([]);
  const [history, setHistory] = useState<CostHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedProduct("");
    setHistory([]);
    if (!selectedSupplier) {
      setProducts([]);
      return;
    }
    apiFetch<{ products: SupplierProductRow[] }>(`/admin/inventory/cutover/suppliers/${selectedSupplier}/products`)
      .then(body => setProducts(body.products))
      .catch((err: unknown) => console.error("Failed to fetch products:", err));
  }, [selectedSupplier]);

  useEffect(() => {
    if (!selectedSupplier || !selectedProduct) {
      setHistory([]);
      return;
    }
    setLoading(true);
    setError(null);
    apiFetch<{ costHistory: CostHistoryEntry[] }>(
      `/admin/inventory/cutover/suppliers/${selectedSupplier}/products/${selectedProduct}/cost-history`
    )
      .then(body => setHistory(body.costHistory))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to fetch cost history"))
      .finally(() => setLoading(false));
  }, [selectedSupplier, selectedProduct]);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-(--color-ink)">Supplier cost history</h2>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-(--color-ink-secondary)">Select supplier</label>
          <select
            value={selectedSupplier}
            onChange={e => setSelectedSupplier(e.target.value)}
            className={selectClass}
          >
            <option value="">-- Select a supplier --</option>
            {suppliers.filter(s => s.isActive).map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-(--color-ink-secondary)">Select product</label>
          <select
            value={selectedProduct}
            onChange={e => setSelectedProduct(e.target.value)}
            disabled={!selectedSupplier}
            className={`${selectClass} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            <option value="">-- Select a product --</option>
            {products.map(p => (
              <option key={p.id} value={p.productId}>
                {p.productName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-(--color-ink-tertiary)">Loading cost history…</p>
      ) : (
        selectedSupplier &&
        selectedProduct &&
        (history.length === 0 ? (
          <p className="py-8 text-center text-sm text-(--color-ink-tertiary)">No cost history found for this product.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-(--color-border-standard)">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-(--color-border-standard) bg-(--color-surface)">
                  <th className="px-3 py-2 text-left font-medium text-(--color-ink-secondary)">Effective date</th>
                  <th className="px-3 py-2 text-left font-medium text-(--color-ink-secondary)">Cost</th>
                  <th className="px-3 py-2 text-left font-medium text-(--color-ink-secondary)">Created at</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry, idx) => (
                  <tr key={idx} className="border-b border-(--color-border-subtle) last:border-b-0">
                    <td className="tabular px-3 py-2">{new Date(entry.effectiveAt).toLocaleDateString()}</td>
                    <td className="tabular px-3 py-2 font-medium">${parseFloat(entry.cost).toFixed(2)}</td>
                    <td className="tabular px-3 py-2 text-(--color-ink-secondary)">{new Date(entry.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}

const selectClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";
