import { useEffect, useState } from "react";
import { Table, type Column } from "../../components/ui/Table";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import { useAuth } from "../../lib/auth/AuthContext";

type Device = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  lastActiveAt: string | null;
  activatedAt: string;
  /** Locked out after repeated wrong PINs; unlocks by itself after 15 minutes. */
  pinLocked: boolean;
};

export function DevicesScreen() {
  const { user } = useAuth();
  const [locationId, setLocationId] = useState(user.currentLocation?.locationId ?? user.accessibleLocations[0]?.locationId ?? "");
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<Device | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async (locId: string) => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiFetch<{ data: Device[] }>(`/auth/devices?locationId=${locId}`);
      setDevices(body.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load devices");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (locationId) load(locationId);
  }, [locationId]);

  const handleDeactivate = async () => {
    if (!deactivating) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/auth/device/${deactivating.id}/deactivate`, { method: "POST" });
      setDevices(prev => prev.filter(d => d.id !== deactivating.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to deactivate device");
    } finally {
      setDeactivating(null);
      setSaving(false);
    }
  };

  const handleUnlock = async (device: Device) => {
    setError(null);
    try {
      await apiFetch(`/auth/device/${device.id}/unlock`, { method: "POST" });
      setDevices(prev => prev.map(d => (d.id === device.id ? { ...d, pinLocked: false } : d)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to unlock device");
    }
  };

  const columns: Column<Device>[] = [
    {
      key: "name",
      header: "Name",
      render: (v, device) => (
        <span className="flex items-center gap-2">
          {v as string}
          {device.pinLocked && (
            <span className="rounded-full border border-(--color-warning) bg-(--color-warning-bg) px-2 py-0.5 text-xs font-medium text-(--color-warning)">
              Locked
            </span>
          )}
        </span>
      ),
    },
    { key: "type", header: "Type" },
    { key: "activatedAt", header: "Activated", render: v => new Date(v as string).toLocaleString() },
    { key: "lastActiveAt", header: "Last active", render: v => (v ? new Date(v as string).toLocaleString() : "—") },
    {
      key: "id",
      header: "Actions",
      render: (_v, device) => (
        <span className="flex gap-4">
          {device.pinLocked && (
            <button onClick={() => handleUnlock(device)} className="text-(--color-ink) hover:opacity-80">
              Unlock
            </button>
          )}
          <button
            onClick={() => setDeactivating(device)}
            className="text-(--color-destructive) hover:opacity-80"
          >
            Deactivate
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-(--color-ink)">Devices ({devices.length})</h1>
        {user.accessibleLocations.length > 1 && (
          <select
            value={locationId}
            onChange={e => setLocationId(e.target.value)}
            className="rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-1.5 text-sm text-(--color-ink)"
          >
            {user.accessibleLocations.map(loc => (
              <option key={loc.locationId} value={loc.locationId}>
                {loc.locationName}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}

      <Table
        data={devices}
        columns={columns}
        keyExtractor={d => d.id}
        emptyMessage={loading ? "Loading…" : "No active devices found."}
      />

      <ConfirmDialog
        open={deactivating !== null}
        title="Deactivate device"
        description={`"${deactivating?.name}" will be signed out and need owner/manager credentials to be reactivated.`}
        confirmPhrase={deactivating?.name ?? ""}
        confirmLabel={saving ? "Deactivating…" : "Deactivate"}
        destructive
        onConfirm={handleDeactivate}
        onCancel={() => setDeactivating(null)}
      />
    </div>
  );
}
