import { useEffect, useState, type ReactNode } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import { useLocations } from "../../lib/useLocations";

type StatusResult = { success: boolean; paused: boolean };
type TestResult = { success: boolean; message: string; eventId?: string; paused?: boolean };

/**
 * Ported from WebhookTest.jsx. The one real fix: the legacy tool free-typed
 * a Square location id with a hardcoded default ("L60AMVPDZJ48F") — paste
 * the wrong id and you silently test against the wrong store. This picks
 * from real synced locations instead (via useLocations, same hook every
 * other screen uses) — note the value has to be the *Square* location id,
 * not our internal location.id, since this endpoint builds a mock Square
 * webhook payload, so it can't reuse <LocationPicker> as-is.
 */
export function WebhookTestScreen() {
  const { locations } = useLocations();
  const [paymentId, setPaymentId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [squareLocationId, setSquareLocationId] = useState("");
  const [amount, setAmount] = useState(100);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);

  const locationsWithSquareId = locations.filter(l => l.squareId);

  useEffect(() => {
    apiFetch<StatusResult>("/api/webhooks/square/test/status")
      .then(data => setIsPaused(data.paused ?? false))
      .catch((err: unknown) => console.error("Failed to fetch webhook status:", err))
      .finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => {
    if (!squareLocationId && locationsWithSquareId.length > 0) {
      setSquareLocationId(locationsWithSquareId[0].squareId!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations.length]);

  const handlePause = async () => {
    try {
      await apiFetch("/api/webhooks/square/test/pause", { method: "POST" });
      setIsPaused(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to pause webhook testing");
    }
  };

  const handleResume = async () => {
    try {
      await apiFetch("/api/webhooks/square/test/resume", { method: "POST" });
      setIsPaused(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to resume webhook testing");
    }
  };

  const handleTest = async () => {
    if (isPaused) {
      setError("Webhook testing is paused. Please resume to send test webhooks.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await apiFetch<TestResult>("/api/webhooks/square/test", {
        method: "POST",
        body: JSON.stringify({
          paymentId: paymentId || undefined,
          orderId: orderId || undefined,
          locationId: squareLocationId,
          amount,
        }),
      });
      if (data.success) {
        setResult(data);
      } else {
        setError(data.message || "Webhook test failed");
        if (data.paused) setIsPaused(true);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to test webhook");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-(--color-ink)">Webhook Test</h1>
        {!statusLoading && (
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                isPaused ? "bg-(--color-destructive-bg) text-(--color-destructive)" : "bg-(--color-success-bg) text-(--color-success)"
              }`}
            >
              {isPaused ? "PAUSED" : "ACTIVE"}
            </span>
            <button
              onClick={isPaused ? handleResume : handlePause}
              className={`rounded-sm px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) ${
                isPaused ? "bg-(--color-success)" : "bg-(--color-destructive)"
              }`}
            >
              {isPaused ? "Resume" : "Pause"}
            </button>
          </div>
        )}
      </div>

      <p className="mb-4 text-sm text-(--color-ink-tertiary)">
        Simulate a Square payment webhook to test sale processing.
        {isPaused && (
          <strong className="mt-1 block text-(--color-destructive)">Webhook testing is paused. Jobs will not be sent.</strong>
        )}
      </p>

      <div className="space-y-4 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
        <Field label="Payment ID (optional, auto-generated if empty)">
          <input value={paymentId} onChange={e => setPaymentId(e.target.value)} placeholder="test_payment_123" className={inputClass} />
        </Field>
        <Field label="Order ID (optional, auto-generated if empty)">
          <input value={orderId} onChange={e => setOrderId(e.target.value)} placeholder="test_order_123" className={inputClass} />
        </Field>
        <Field label="Location">
          <select value={squareLocationId} onChange={e => setSquareLocationId(e.target.value)} className={inputClass}>
            {locationsWithSquareId.length === 0 && <option value="">No Square-synced locations</option>}
            {locationsWithSquareId.map(l => (
              <option key={l.id} value={l.squareId!}>
                {l.name} ({l.squareId})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount (cents)">
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(parseInt(e.target.value) || 0)}
            min={1}
            className={`tabular ${inputClass}`}
          />
        </Field>
        <button
          onClick={handleTest}
          disabled={loading || isPaused || !squareLocationId}
          className="rounded-sm bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Sending…" : isPaused ? "Paused — cannot send" : "Send test webhook"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}
      {result && (
        <div className="mt-4 rounded-md border border-(--color-success) bg-(--color-success-bg) p-4 text-sm text-(--color-success)">
          <h3 className="mb-1 font-semibold">Webhook test result</h3>
          <p>Status: {result.message}</p>
          <p className="tabular">Event ID: {result.eventId}</p>
          <p className="mt-2 text-(--color-ink-tertiary)">Check the worker logs to see if the sale was processed.</p>
        </div>
      )}
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
