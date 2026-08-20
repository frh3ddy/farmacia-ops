import { useAuth } from "../lib/auth/AuthContext";

export function UserHeader() {
  const { user, logout } = useAuth();

  return (
    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-(--color-border-standard) bg-(--color-surface) px-6 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full border border-(--color-border-standard) bg-(--color-surface-raised) text-sm font-semibold text-(--color-accent)">
          {user.employee.name.charAt(0).toUpperCase()}
        </div>
        <div>
          <p className="text-sm font-medium text-(--color-ink)">{user.employee.name}</p>
          <p className="text-xs text-(--color-ink-tertiary)">
            {user.currentLocation?.locationName ?? "No location"} · {user.currentLocation?.role ?? "Unknown role"}
          </p>
        </div>
      </div>
      <button
        onClick={logout}
        className="text-sm text-(--color-ink-tertiary) transition-colors hover:text-(--color-destructive)"
      >
        Logout
      </button>
    </div>
  );
}
