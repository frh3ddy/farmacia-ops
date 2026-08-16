import { useEffect, useState } from "react";
import { Table, type Column } from "../../components/ui/Table";
import { BatchChip } from "../../components/ui/BatchChip";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import type { InventoryBatch } from "../../lib/dev-tools/types";

type CreateResult = { success: boolean; message: string; count: number };

type GroupedRow = {
  key: string;
  productName: string;
  locationName: string;
  totalQuantity: number;
  batchCount: number;
};

const groupedColumns: Column<GroupedRow>[] = [
  { key: "productName", header: "Product" },
  { key: "locationName", header: "Location" },
  { key: "totalQuantity", header: "Total qty", align: "right", render: v => <span className="tabular font-semibold">{String(v)}</span> },
  { key: "batchCount", header: "Batches", align: "right", render: v => <span className="tabular">{String(v)}</span> },
];

const batchColumns: Column<InventoryBatch>[] = [
  { key: "product", header: "Product", render: (_v, item) => item.product?.name ?? "N/A" },
  { key: "location", header: "Location", render: (_v, item) => item.location?.name ?? item.location?.squareId ?? "N/A" },
  { key: "quantity", header: "Quantity", align: "right", render: v => <span className="tabular font-semibold">{String(v)}</span> },
  { key: "unitCost", header: "Unit cost", align: "right", render: v => <span className="tabular">${parseFloat(v as string).toFixed(2)}</span> },
  {
    key: "unitCost",
    header: "Total cost",
    align: "right",
    render: (v, item) => <span className="tabular">${(parseFloat(v as string) * item.quantity).toFixed(2)}</span>,
  },
  { key: "receivedAt", header: "Received", render: v => <BatchChip variant="age" receivedAt={v as string} /> },
  { key: "createdAt", header: "Created", render: v => new Date(v as string).toLocaleDateString() },
];

export function TestInventoryScreen() {
  const [inventory, setInventory] = useState<InventoryBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<CreateResult | null>(null);

  const fetchInventory = () => {
    setLoading(true);
    setError(null);
    apiFetch<{ data: InventoryBatch[] }>("/api/inventory")
      .then(body => setInventory(body.data))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to fetch inventory"))
      .finally(() => setLoading(false));
  };

  useEffect(fetchInventory, []);

  const handleCreateTestInventory = async () => {
    setCreating(true);
    setError(null);
    setCreateResult(null);
    try {
      const data = await apiFetch<CreateResult>("/api/inventory/test", {
        method: "POST",
        body: JSON.stringify({ squareVariationIds: ["YWASJW42SCO2V6MSXMTI55H5"] }),
      });
      setCreateResult(data);
      fetchInventory();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create test inventory");
    } finally {
      setCreating(false);
    }
  };

  const grouped = new Map<string, GroupedRow>();
  for (const item of inventory) {
    const key = `${item.productId}-${item.locationId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.totalQuantity += item.quantity;
      existing.batchCount += 1;
    } else {
      grouped.set(key, {
        key,
        productName: item.product?.name ?? "N/A",
        locationName: item.location?.name ?? item.location?.squareId ?? "N/A",
        totalQuantity: item.quantity,
        batchCount: 1,
      });
    }
  }

  if (loading) return <p className="text-sm text-(--color-ink-tertiary)">Loading inventory…</p>;
  if (error)
    return (
      <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
        {error}
      </div>
    );

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-(--color-ink)">Test Inventory ({inventory.length} batches)</h1>
        <div className="flex gap-2">
          <button
            onClick={handleCreateTestInventory}
            disabled={creating}
            className="rounded-sm bg-(--color-success) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
          >
            {creating ? "Creating…" : "Pull test inventory"}
          </button>
          <button
            onClick={fetchInventory}
            className="rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface-raised)"
          >
            Refresh
          </button>
        </div>
      </div>

      {createResult && (
        <div className="mb-4 rounded-md border border-(--color-success) bg-(--color-success-bg) px-4 py-2 text-sm text-(--color-success)">
          <strong>Success!</strong> {createResult.message} — created {createResult.count} inventory batch(es).
        </div>
      )}

      <div className="mb-6 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4 text-sm text-(--color-ink-secondary)">
        <p>
          <strong className="text-(--color-ink)">Note:</strong> This tool creates test data — not a production inventory feature.
        </p>
        <p className="mt-1">
          <strong className="text-(--color-ink)">Total unique products:</strong> <span className="tabular">{grouped.size}</span>
        </p>
        <p className="mt-1">
          <strong className="text-(--color-ink)">Pull test inventory:</strong> creates test batches (100 units @ $5.00 each) for a
          fixed Square variation id plus a few other products.
        </p>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-(--color-ink-tertiary)">By product &amp; location</h2>
      <Table data={[...grouped.values()]} columns={groupedColumns} keyExtractor={r => r.key} />

      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-(--color-ink-tertiary)">
        All inventory batches (FIFO order)
      </h2>
      <Table
        data={inventory}
        columns={batchColumns}
        keyExtractor={i => i.id}
        emptyMessage="No inventory records found. Create inventory batches to track stock."
      />
    </div>
  );
}
