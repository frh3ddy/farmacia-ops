import { useAuth } from "../lib/auth/AuthContext";

function PowerIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path strokeLinecap="round" d="M12 3v7" />
      <path strokeLinecap="round" d="M7 5.5a8 8 0 1 0 10 0" />
    </svg>
  );
}

/** Current user + logout — lives at the bottom of Sidebar, not a page-level
 * header, so it has no sticky/bar-of-its-own styling of its own; Sidebar's
 * own layout (flex column, this as the shrink-0 last child) is what keeps
 * it pinned below the scrollable nav list. */
export function UserHeader() {
  const { user, logout } = useAuth();

  return (
    <div className="border-t border-(--color-border-standard) p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-(--color-border-standard) bg-(--color-surface-raised) text-sm font-semibold text-(--color-accent)">
          {user.employee.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-(--color-ink)">{user.employee.name}</p>
          <p className="truncate text-xs text-(--color-ink-tertiary)">
            {user.currentLocation?.locationName ?? "No location"} · {user.currentLocation?.role ?? "Unknown role"}
          </p>
        </div>
      </div>
      <button
        onClick={logout}
        className="mt-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-(--color-destructive) transition-colors hover:text-(--color-destructive)/80"
      >
        <PowerIcon className="h-4 w-4" />
        Logout
      </button>
    </div>
  );
}
