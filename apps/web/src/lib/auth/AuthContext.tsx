import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "../apiFetch";
import { LoginForm } from "../../components/auth/LoginForm";
import { SetupForm } from "../../components/auth/SetupForm";
import type { AuthUser, MeResult, PinLoginResult, SetupStatus } from "./types";

type AuthContextValue = {
  user: AuthUser;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}

/**
 * Mirrors the legacy Auth.jsx AuthProvider: gates rendering until the
 * setup/session check resolves, then shows Setup, Login, or `children`.
 * Ported 1:1 in behavior — device token + PIN session flow is unchanged,
 * only the auth *headers* now live in apiFetch (lib/apiFetch.ts) instead of
 * a context-provided `authFetch`, since every screen already imports it.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  useEffect(() => {
    checkSetupAndSession();
  }, []);

  const checkSetupAndSession = async () => {
    try {
      const setupBody = await apiFetch<{ data: SetupStatus }>("/auth/setup/status");
      if (setupBody.data.needsSetup) {
        setNeedsSetup(true);
        setShowSetup(true);
        setLoading(false);
        return;
      }

      const sessionToken = localStorage.getItem("sessionToken");
      if (sessionToken) {
        try {
          const meBody = await apiFetch<{ data: MeResult }>("/auth/me");
          setUser(meBody.data);
        } catch {
          localStorage.removeItem("sessionToken");
        }
      }
    } catch (err) {
      console.error("Auth check failed:", err);
    } finally {
      setLoading(false);
    }
  };

  const login = (result: PinLoginResult) => {
    setUser({
      employee: result.employee,
      currentLocation: result.currentLocation,
      accessibleLocations: result.accessibleLocations,
    });
  };

  const logout = async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch (err) {
      console.error("Logout error:", err);
    }
    localStorage.removeItem("sessionToken");
    setUser(null);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-(--color-canvas)">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-(--color-border-standard) border-b-(--color-accent)" />
          <p className="mt-4 text-sm text-(--color-ink-tertiary)">Loading…</p>
        </div>
      </div>
    );
  }

  if (showSetup && needsSetup) {
    return (
      <SetupForm
        onSetupComplete={() => {
          setNeedsSetup(false);
          setShowSetup(false);
        }}
        onSwitchToLogin={() => setShowSetup(false)}
      />
    );
  }

  if (!user) {
    return <LoginForm onLogin={login} onSwitchToSetup={needsSetup ? () => setShowSetup(true) : undefined} />;
  }

  return <AuthContext.Provider value={{ user, logout }}>{children}</AuthContext.Provider>;
}
