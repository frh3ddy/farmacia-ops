import { useCallback, useEffect, useState } from "react";
import { Table, type Column } from "../../components/ui/Table";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import type { CatalogMapping } from "../../lib/ops/types";

const columns: Column<CatalogMapping>[] = [
  { key: "squareVariationId", header: "Variation ID", render: v => <code className="tabular text-xs">{String(v)}</code> },
  { key: "product", header: "Product", render: v => (v as CatalogMapping["product"])?.name ?? "N/A" },
  {
    key: "location",
    header: "Location",
    render: (v, item) => (v as CatalogMapping["location"])?.name ?? (item.locationId ?? "Global"),
  },
  { key: "syncedAt", header: "Synced At", render: v => new Date(v as string).toLocaleString() },
];

export function CatalogMappingsScreen() {
  const [mappings, setMappings] = useState<CatalogMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMappings = useCallback(() => {
    setLoading(true);
    setError(null);
    return apiFetch<{ data: CatalogMapping[] }>("/api/catalog/mappings")
      .then(body => setMappings(body.data))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to fetch mappings"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchMappings();
  }, [fetchMappings]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-(--color-ink)">Catalog Mappings ({mappings.length})</h1>
        <button
          onClick={() => fetchMappings()}
          disabled={loading}
          className="rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface-raised) disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {error && (
        <div className="mb-4 rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}
      <Table data={mappings} columns={columns} keyExtractor={m => m.id} emptyMessage="No catalog mappings found." />
    </div>
  );
}
