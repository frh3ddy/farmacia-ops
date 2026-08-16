import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import type { DeviceActivateResult, PinLoginResult } from "../../lib/auth/types";

type Step = "device" | "pin";

type LoginFormProps = {
  onLogin: (result: PinLoginResult) => void;
  onSwitchToSetup?: () => void;
};

export function LoginForm({ onLogin, onSwitchToSetup }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [step, setStep] = useState<Step>("device");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [deviceToken, setDeviceToken] = useState(localStorage.getItem("deviceToken"));

  useEffect(() => {
    if (deviceToken) setStep("pin");
  }, [deviceToken]);

  const handleDeviceActivation = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const body = await apiFetch<{ data: DeviceActivateResult }>("/auth/device/activate", {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          deviceName: `Web Browser - ${navigator.userAgent.split(" ").slice(-1)[0]}`,
          deviceType: "WEB",
        }),
      });
      localStorage.setItem("deviceToken", body.data.deviceToken);
      setDeviceToken(body.data.deviceToken);
      setStep("pin");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Device activation failed");
    } finally {
      setLoading(false);
    }
  };

  const handlePinLogin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const body = await apiFetch<{ data: PinLoginResult }>("/auth/pin", {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceToken}` },
        body: JSON.stringify({ pin }),
      });
      localStorage.setItem("sessionToken", body.data.sessionToken);
      onLogin(body.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "PIN login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleDeactivateDevice = () => {
    localStorage.removeItem("deviceToken");
    localStorage.removeItem("sessionToken");
    setDeviceToken(null);
    setStep("device");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-(--color-canvas) p-4">
      <div className="w-full max-w-md rounded-lg border border-(--color-border-standard) bg-(--color-surface-raised) p-8">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold text-(--color-ink)">Farmacia Ops</h1>
          <p className="mt-1 text-sm text-(--color-ink-tertiary)">
            {step === "device" ? "Activate this device" : "Enter your PIN to continue"}
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-3 text-sm text-(--color-destructive)">
            {error}
          </div>
        )}

        {step === "device" ? (
          <form onSubmit={handleDeviceActivation} className="space-y-4">
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                placeholder="owner@pharmacy.com"
                required
                className={inputClass}
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                value={password}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className={inputClass}
              />
            </Field>
            <PrimaryButton loading={loading} loadingLabel="Activating…">
              Activate device
            </PrimaryButton>
          </form>
        ) : (
          <form onSubmit={handlePinLogin} className="space-y-4">
            <Field label="PIN">
              <input
                type="password"
                value={pin}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setPin(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="••••"
                maxLength={6}
                required
                className={`${inputClass} tabular text-center text-2xl tracking-widest`}
              />
            </Field>
            <PrimaryButton loading={loading} loadingLabel="Logging in…" disabled={pin.length < 4}>
              Login
            </PrimaryButton>
            <button
              type="button"
              onClick={handleDeactivateDevice}
              className="w-full py-2 text-sm text-(--color-ink-tertiary) hover:text-(--color-ink)"
            >
              Use a different account
            </button>
          </form>
        )}

        {onSwitchToSetup && (
          <div className="mt-6 border-t border-(--color-border-subtle) pt-6 text-center">
            <button
              onClick={onSwitchToSetup}
              className="text-sm font-medium text-(--color-accent) hover:text-(--color-accent-hover)"
            >
              First time? Set up your account
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-4 py-2.5 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-(--color-ink-secondary)">{label}</label>
      {children}
    </div>
  );
}

function PrimaryButton({
  children,
  loading,
  loadingLabel,
  disabled,
}: {
  children: ReactNode;
  loading: boolean;
  loadingLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="w-full rounded-sm bg-(--color-accent) py-2.5 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? loadingLabel : children}
    </button>
  );
}
