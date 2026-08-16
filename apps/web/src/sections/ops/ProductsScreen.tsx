import { useEffect, useState } from "react";
import { Table, type Column } from "../../components/ui/Table";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import type { Product, ProductSupplier, ProductSupplierCostHistoryGroup } from "../../lib/ops/types";

const columns: Column<Product>[] = [
  { key: "id", header: "ID", render: v => <code className="tabular text-xs">{String(v).slice(0, 8)}…</code> },
  { key: "name", header: "Name" },
  { key: "squareProductName", header: "Square product name", render: v => (v as string | null) ?? "-" },
  { key: "sku", header: "SKU", render: v => (v as string | null) ?? "-" },
  { key: "category", header: "Category", render: v => (v as Product["category"])?.name ?? "-" },
  {
    key: "supplierCount",
    header: "Suppliers",
    render: v =>
      (v as number) > 0 ? (
        <span className="rounded-full bg-(--color-success-bg) px-2 py-0.5 text-xs font-medium text-(--color-success)">
          {v as number}
        </span>
      ) : (
        <span className="text-(--color-ink-muted)">—</span>
      ),
  },
  {
    key: "catalogMappings",
    header: "Mappings",
    render: v => (
      <span className="rounded-full bg-(--color-surface-inset) px-2 py-0.5 text-xs font-medium text-(--color-ink-secondary)">
        {(v as unknown[] | undefined)?.length ?? 0}
      </span>
    ),
  },
  { key: "createdAt", header: "Created", render: v => new Date(v as string).toLocaleDateString() },
];

export function ProductsScreen() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ data: Product[] }>("/api/products")
      .then(body => setProducts(body.data))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to fetch products"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-(--color-ink-tertiary)">Loading products…</p>;
  if (error)
    return (
      <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
        {error}
      </div>
    );

  const selectedProduct = products.find(p => p.id === selectedProductId) ?? null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-(--color-ink)">Products ({products.length})</h1>
        {selectedProductId && (
          <button
            onClick={() => setSelectedProductId(null)}
            className="rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface-raised)"
          >
            Clear selection
          </button>
        )}
      </div>

      <div className={`grid gap-6 ${selectedProductId ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"}`}>
        <Table
          data={products}
          columns={columns}
          keyExtractor={p => p.id}
          onRowClick={p => setSelectedProductId(p.id)}
          isRowSelected={p => p.id === selectedProductId}
        />

        {selectedProductId && selectedProduct && (
          <ProductSupplierPanel product={selectedProduct} />
        )}
      </div>
    </div>
  );
}

function ProductSupplierPanel({ product }: { product: Product }) {
  const [suppliers, setSuppliers] = useState<ProductSupplier[]>([]);
  const [costHistories, setCostHistories] = useState<ProductSupplierCostHistoryGroup[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setExpanded(new Set());
    Promise.all([
      apiFetch<{ suppliers: ProductSupplier[] }>(`/admin/inventory/cutover/products/${product.id}/suppliers`),
      apiFetch<{ suppliers: ProductSupplierCostHistoryGroup[] }>(
        `/admin/inventory/cutover/products/${product.id}/suppliers/cost-history`
      ),
    ])
      .then(([suppliersBody, historyBody]) => {
        setSuppliers(suppliersBody.suppliers);
        setCostHistories(historyBody.suppliers);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : "Failed to load supplier data")
      )
      .finally(() => setLoading(false));
  }, [product.id]);

  const toggle = (supplierId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(supplierId) ? next.delete(supplierId) : next.add(supplierId);
      return next;
    });
  };

  const historyFor = (supplierId: string) =>
    costHistories.find(s => s.supplierId === supplierId)?.costHistory ?? [];

  return (
    <div className="space-y-4 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
      {loading ? (
        <p className="py-6 text-center text-sm text-(--color-ink-tertiary)">Loading supplier data…</p>
      ) : error ? (
        <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-3 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      ) : (
        <>
          <div className="border-b border-(--color-border-subtle) pb-3">
            <h3 className="font-semibold text-(--color-ink)">{product.name}</h3>
            {product.squareProductName && (
              <p className="text-sm text-(--color-ink-secondary)">{product.squareProductName}</p>
            )}
            {product.sku && <p className="mt-1 text-xs text-(--color-ink-tertiary)">SKU: {product.sku}</p>}
          </div>

          {suppliers.length === 0 ? (
            <p className="py-6 text-center text-sm text-(--color-ink-tertiary)">No suppliers found for this product.</p>
          ) : (
            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-tertiary)">
                Suppliers ({suppliers.length})
              </h4>
              {suppliers.map(supplier => {
                const history = historyFor(supplier.id);
                const isExpanded = expanded.has(supplier.id);
                return (
                  <div key={supplier.id} className="overflow-hidden rounded-md border border-(--color-border-standard)">
                    <div
                      onClick={() => toggle(supplier.id)}
                      className="cursor-pointer bg-(--color-surface) p-3 hover:bg-(--color-surface-inset)"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-(--color-ink)">{supplier.name}</span>
                            {supplier.isPreferred && (
                              <span className="rounded-full bg-(--color-success-bg) px-2 py-0.5 text-xs font-medium text-(--color-success)">
                                Preferred
                              </span>
                            )}
                          </div>
                          <p className="mt-1 tabular text-sm text-(--color-ink-secondary)">
                            Current cost: <span className="font-semibold text-(--color-ink)">${parseFloat(supplier.cost).toFixed(2)}</span>
                          </p>
                        </div>
                        {history.length > 0 && (
                          <span className="text-xs text-(--color-ink-tertiary)">
                            {isExpanded ? "▼" : "▶"} {history.length} history entries
                          </span>
                        )}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="border-t border-(--color-border-subtle)">
                        {history.length === 0 ? (
                          <p className="p-3 text-center text-sm text-(--color-ink-tertiary)">No cost history available.</p>
                        ) : (
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-(--color-surface) text-xs uppercase text-(--color-ink-tertiary)">
                                <th className="px-3 py-1.5 text-left">Effective</th>
                                <th className="px-3 py-1.5 text-left">Cost</th>
                                <th className="px-3 py-1.5 text-left">Source</th>
                                <th className="px-3 py-1.5 text-left">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {history.map(entry => (
                                <tr key={entry.id} className={entry.isCurrent ? "bg-(--color-accent)/5" : ""}>
                                  <td className="tabular px-3 py-1.5">{new Date(entry.effectiveAt).toLocaleDateString()}</td>
                                  <td className="tabular px-3 py-1.5 font-medium">${parseFloat(entry.cost).toFixed(2)}</td>
                                  <td className="px-3 py-1.5 text-(--color-ink-secondary)">{entry.source}</td>
                                  <td className="px-3 py-1.5">
                                    {entry.isCurrent && (
                                      <span className="rounded-full bg-(--color-accent)/10 px-2 py-0.5 text-xs font-medium text-(--color-accent)">
                                        Current
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
