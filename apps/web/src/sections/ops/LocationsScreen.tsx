import { useState } from "react";
import { Table, type Column } from "../../components/ui/Table";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import { useLocations } from "../../lib/useLocations";
import { useAuth } from "../../lib/auth/AuthContext";
import { isOwner } from "../../lib/auth/types";
import type { Location } from "../../lib/types";

type SyncResult = { created: number; updated: number; total: number };

const columns: Column<Location>[] = [
  { key: "id", header: "ID", render: v => <code className="tabular text-xs">{String(v).slice(0, 8)}…</code> },
  { key: "name", header: "Name" },
  { key: "address", header: "Address", render: v => (v as string | null) ?? "-" },
  {
    key: "isActive",
    header: "Status",
    render: v => (
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
          v
            ? "bg-(--color-success-bg) text-(--color-success)"
            : "bg-(--color-destructive-bg) text-(--color-destructive)"
        }`}
      >
        {v ? "Active" : "Inactive"}
      </span>
    ),
  },
  { key: "createdAt", header: "Created", render: v => new Date(v as string).toLocaleDateString() },
];

export function LocationsScreen() {
  const { user } = useAuth();
  const { locations, loading, error, refetch } = useLocations();
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncMessage(null);
    try {
      const body = await apiFetch<{ result: SyncResult }>("/locations/sync", { method: "POST" });
      await refetch();
      setSyncMessage(`Synced: ${body.result.created} created, ${body.result.updated} updated`);
    } catch (err) {
      setSyncError(err instanceof ApiError ? err.message : "Failed to sync locations from Square");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-(--color-ink)">Locations ({locations.length})</h1>
        <div className="flex gap-2">
          {isOwner(user) && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className="rounded-sm bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:opacity-50"
            >
              {syncing ? "Syncing…" : "Sync from Square"}
            </button>
          )}
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface-raised) disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {syncMessage && (
        <div className="mb-4 rounded-md border border-(--color-success) bg-(--color-success-bg) px-4 py-2 text-sm text-(--color-success)">
          {syncMessage}
        </div>
      )}
      {(syncError || error) && (
        <div className="mb-4 rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {syncError ?? error}
        </div>
      )}

      <Table data={locations} columns={columns} keyExtractor={l => l.id} emptyMessage="No locations found." />
    </div>
  );
}
