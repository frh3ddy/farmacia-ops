import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import type { SetupLocation, SetupStatus } from "../../lib/auth/types";

type SyncLocationsResult = { created: number; updated: number; total: number; locations: SetupLocation[] };

type FormState = {
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  confirmPassword: string;
  ownerPin: string;
  confirmPin: string;
  locationId: string;
};

const initialForm: FormState = {
  ownerName: "",
  ownerEmail: "",
  ownerPassword: "",
  confirmPassword: "",
  ownerPin: "",
  confirmPin: "",
  locationId: "",
};

type SetupFormProps = {
  onSetupComplete: () => void;
  onSwitchToLogin: () => void;
};

export function SetupForm({ onSetupComplete, onSwitchToLogin }: SetupFormProps) {
  const [availableLocations, setAvailableLocations] = useState<SetupLocation[]>([]);
  const [form, setForm] = useState<FormState>(initialForm);
  const [loading, setLoading] = useState(false);
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [syncingSquare, setSyncingSquare] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    apiFetch<{ data: SetupStatus }>("/auth/setup/status")
      .then(body => {
        if (body.data.locations.length > 0) {
          setAvailableLocations(body.data.locations);
          setForm(prev => ({ ...prev, locationId: body.data.locations[0].id }));
        }
      })
      .catch(err => console.error("Failed to fetch locations:", err))
      .finally(() => setLoadingLocations(false));
  }, []);

  const handleSyncFromSquare = async () => {
    setSyncingSquare(true);
    setError("");
    try {
      const body = await apiFetch<{ data: SyncLocationsResult }>("/auth/setup/sync-locations", {
        method: "POST",
      });
      if (body.data.locations.length > 0) {
        setAvailableLocations(body.data.locations);
        setForm(prev => ({ ...prev, locationId: body.data.locations[0].id }));
        setSuccess(`Synced ${body.data.total} location(s) from Square!`);
        setTimeout(() => setSuccess(""), 3000);
      } else {
        setError("No locations found in Square");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to sync from Square");
    } finally {
      setSyncingSquare(false);
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");

    if (form.ownerPassword !== form.confirmPassword) {
      setError("Passwords do not match");
      setLoading(false);
      return;
    }
    if (form.ownerPin !== form.confirmPin) {
      setError("PINs do not match");
      setLoading(false);
      return;
    }
    if (!/^\d{4,6}$/.test(form.ownerPin)) {
      setError("PIN must be 4-6 digits");
      setLoading(false);
      return;
    }
    if (!form.locationId) {
      setError("Please select a location. Sync from Square first if none are listed.");
      setLoading(false);
      return;
    }

    try {
      await apiFetch("/auth/setup/initial", {
        method: "POST",
        body: JSON.stringify({
          ownerName: form.ownerName,
          ownerEmail: form.ownerEmail,
          ownerPassword: form.ownerPassword,
          ownerPin: form.ownerPin,
          locationId: form.locationId,
        }),
      });
      setSuccess("Setup complete! You can now log in.");
      setTimeout(onSetupComplete, 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-(--color-canvas) p-4">
      <div className="w-full max-w-lg rounded-lg border border-(--color-border-standard) bg-(--color-surface-raised) p-8">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold text-(--color-ink)">Welcome to Farmacia Ops</h1>
          <p className="mt-1 text-sm text-(--color-ink-tertiary)">Let's set up your pharmacy</p>
        </div>

        {error && (
          <div className="mb-6 rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-3 text-sm text-(--color-destructive)">
            {error}
          </div>
        )}
        {success && (
          <div className="mb-6 rounded-md border border-(--color-success) bg-(--color-success-bg) px-4 py-3 text-sm text-(--color-success)">
            {success}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <fieldset className="space-y-3 border-b border-(--color-border-subtle) pb-4">
            <legend className="mb-1 text-sm font-semibold text-(--color-ink)">Owner account</legend>
            <Field label="Your name">
              <input
                name="ownerName"
                value={form.ownerName}
                onChange={handleChange}
                placeholder="Jane Doe"
                required
                className={inputClass}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                name="ownerEmail"
                value={form.ownerEmail}
                onChange={handleChange}
                placeholder="owner@pharmacy.com"
                required
                className={inputClass}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Password">
                <input
                  type="password"
                  name="ownerPassword"
                  value={form.ownerPassword}
                  onChange={handleChange}
                  minLength={6}
                  required
                  className={inputClass}
                />
              </Field>
              <Field label="Confirm password">
                <input
                  type="password"
                  name="confirmPassword"
                  value={form.confirmPassword}
                  onChange={handleChange}
                  required
                  className={inputClass}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="PIN (4-6 digits)">
                <input
                  type="password"
                  value={form.ownerPin}
                  onChange={e => setForm({ ...form, ownerPin: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                  maxLength={6}
                  required
                  className={`${inputClass} tabular text-center`}
                />
              </Field>
              <Field label="Confirm PIN">
                <input
                  type="password"
                  value={form.confirmPin}
                  onChange={e => setForm({ ...form, confirmPin: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                  maxLength={6}
                  required
                  className={`${inputClass} tabular text-center`}
                />
              </Field>
            </div>
          </fieldset>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-(--color-ink)">Location</h3>
              <button
                type="button"
                onClick={handleSyncFromSquare}
                disabled={syncingSquare}
                className="text-sm text-(--color-accent) hover:text-(--color-accent-hover) disabled:text-(--color-ink-muted)"
              >
                {syncingSquare ? "Syncing…" : "Sync from Square"}
              </button>
            </div>

            {availableLocations.length > 0 ? (
              <Field label="Select location">
                <select name="locationId" value={form.locationId} onChange={handleChange} required className={inputClass}>
                  <option value="">Select a location…</option>
                  {availableLocations.map(loc => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                      {loc.squareId ? ` (Square: ${loc.squareId.slice(0, 8)}…)` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <p className="text-sm text-(--color-ink-tertiary)">
                {loadingLocations ? "Loading locations…" : "No locations yet — sync from Square to continue."}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || availableLocations.length === 0}
            className="mt-2 w-full rounded-sm bg-(--color-accent) py-2.5 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Setting up…" : "Complete setup"}
          </button>
        </form>

        <div className="mt-6 border-t border-(--color-border-subtle) pt-6 text-center">
          <button
            onClick={onSwitchToLogin}
            className="text-sm font-medium text-(--color-accent) hover:text-(--color-accent-hover)"
          >
            Already have an account? Login
          </button>
        </div>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-(--color-ink-secondary)">{label}</label>
      {children}
    </div>
  );
}
