import { useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { LocationPicker } from "../../components/ui/LocationPicker";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import { useAuth } from "../../lib/auth/AuthContext";
import { isOwner } from "../../lib/auth/types";

type SyncResult = {
  totalVariationsFound: number;
  variationsProcessed: number;
  productsCreated: number;
  mappingsCreated: number;
  mappingsSkipped: number;
  errors?: { variationName: string; error: string }[];
};

type CleanupResult = {
  costApprovalsDeleted: number;
  mappingsDeleted: number;
  supplierProductsDeleted: number;
  costHistoryDeleted: number;
  inventoryDeleted: number;
  saleItemsDeleted: number;
  placementsDeleted: number;
  productsDeleted: number;
  productsUpdated: number;
};

export function CatalogSyncScreen() {
  const { user } = useAuth();
  const [locationId, setLocationId] = useState("");
  const [forceResync, setForceResync] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [confirmingCleanup, setConfirmingCleanup] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);

  const handleSync = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const body = await apiFetch<{ result: SyncResult }>("/admin/square/catalog/sync", {
        method: "POST",
        body: JSON.stringify({ locationId: locationId || null, forceResync }),
      });
      setResult(body.result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to sync catalog");
    } finally {
      setLoading(false);
    }
  };

  const handleCleanup = async () => {
    setConfirmingCleanup(false);
    setCleaningUp(true);
    setError(null);
    setCleanupResult(null);
    try {
      const body = await apiFetch<{ data: CleanupResult }>("/api/catalog/cleanup", {
        method: "POST",
        body: JSON.stringify({ deleteProducts: true }),
      });
      setCleanupResult(body.data);
      setResult(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to cleanup catalog");
    } finally {
      setCleaningUp(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <h1 className="mb-4 text-xl font-semibold text-(--color-ink)">Catalog Sync</h1>

      {isOwner(user) && (
        <div className="mb-6 rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) p-4">
          <p className="mb-3 text-sm text-(--color-destructive)">
            <strong>Cleanup</strong> deletes ALL cost approvals, catalog mappings, supplier products, cost history,
            inventory, sale items, placements, and products — a full reset, not reversible.
          </p>
          <button
            onClick={() => setConfirmingCleanup(true)}
            disabled={cleaningUp}
            className="rounded-sm bg-(--color-destructive) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
          >
            {cleaningUp ? "Cleaning up…" : "Cleanup catalog"}
          </button>
          {cleanupResult && (
            <p className="mt-3 text-sm text-(--color-success)">
              Deleted {cleanupResult.costApprovalsDeleted} cost approvals, {cleanupResult.mappingsDeleted} mappings,{" "}
              {cleanupResult.supplierProductsDeleted} supplier products, {cleanupResult.costHistoryDeleted} cost
              history records, {cleanupResult.inventoryDeleted} inventory records, {cleanupResult.saleItemsDeleted}{" "}
              sale items, {cleanupResult.placementsDeleted} placements, {cleanupResult.productsDeleted} products
              deleted ({cleanupResult.productsUpdated} updated).
            </p>
          )}
        </div>
      )}

      <div className="space-y-4 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-(--color-ink-secondary)">Location (optional)</label>
          <LocationPicker value={locationId} onChange={setLocationId} allowAll allLabel="Global sync (all locations)" />
        </div>
        <label className="flex items-center gap-2 text-sm text-(--color-ink-secondary)">
          <input type="checkbox" checked={forceResync} onChange={e => setForceResync(e.target.checked)} />
          Force resync (re-sync existing mappings)
        </label>
        <button
          onClick={handleSync}
          disabled={loading}
          className="rounded-sm bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:opacity-50"
        >
          {loading ? "Syncing…" : "Sync catalog"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-md border border-(--color-success) bg-(--color-success-bg) p-4 text-sm text-(--color-success)">
          <h3 className="mb-2 font-semibold">Sync results</h3>
          <p>Total variations found: {result.totalVariationsFound}</p>
          <p>Variations processed: {result.variationsProcessed}</p>
          <p>Products created: {result.productsCreated}</p>
          <p>Mappings created: {result.mappingsCreated}</p>
          <p>Mappings skipped: {result.mappingsSkipped}</p>
          {result.errors && result.errors.length > 0 && (
            <div className="mt-2">
              <strong>Errors:</strong>
              <ul className="list-disc pl-5">
                {result.errors.map((err, i) => (
                  <li key={i}>
                    {err.variationName}: {err.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmingCleanup}
        title="Cleanup catalog"
        description="This deletes all products and every record that references them. It cannot be undone."
        confirmPhrase="DELETE"
        confirmLabel="Delete everything"
        destructive
        onConfirm={handleCleanup}
        onCancel={() => setConfirmingCleanup(false)}
      />
    </div>
  );
}
