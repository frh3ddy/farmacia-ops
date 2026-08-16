import { useEffect, useState } from "react";
import { Table, type Column } from "../../../components/ui/Table";
import { apiFetch, ApiError } from "../../../lib/apiFetch";
import { useSuppliers } from "../../../lib/ops/useSuppliers";
import type { SupplierProductRow } from "../../../lib/ops/types";

const columns: Column<SupplierProductRow>[] = [
  { key: "productName", header: "Product name" },
  { key: "sku", header: "SKU", render: v => (v as string | null) ?? "—" },
  { key: "cost", header: "Cost", render: v => `$${parseFloat(v as string).toFixed(2)}` },
  { key: "updatedAt", header: "Last updated", render: v => (v ? new Date(v as string).toLocaleDateString() : "—") },
];

export function SupplierProducts() {
  const { suppliers } = useSuppliers();
  const [selectedSupplier, setSelectedSupplier] = useState("");
  const [products, setProducts] = useState<SupplierProductRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedSupplier) {
      setProducts([]);
      return;
    }
    setLoading(true);
    setError(null);
    apiFetch<{ products: SupplierProductRow[] }>(`/admin/inventory/cutover/suppliers/${selectedSupplier}/products`)
      .then(body => setProducts(body.products))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to fetch supplier products"))
      .finally(() => setLoading(false));
  }, [selectedSupplier]);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-(--color-ink)">Supplier products</h2>

      <div>
        <label className="mb-1 block text-sm font-medium text-(--color-ink-secondary)">Select supplier</label>
        <select
          value={selectedSupplier}
          onChange={e => setSelectedSupplier(e.target.value)}
          className="w-full max-w-xs rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
        >
          <option value="">-- Select a supplier --</option>
          {suppliers.filter(s => s.isActive).map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-(--color-ink-tertiary)">Loading supplier products…</p>
      ) : (
        selectedSupplier && (
          <Table data={products} columns={columns} keyExtractor={p => p.id} emptyMessage="No products found for this supplier." />
        )
      )}
    </div>
  );
}
