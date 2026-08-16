import { formatCutoverError } from "../../lib/cutover/errorFormat";
import type { CutoverError } from "../../lib/cutover/types";

type ErrorBannerProps = {
  error: CutoverError | null | undefined;
  onRetry?: () => void;
  onResume?: () => void;
  onDismiss?: () => void;
};

/**
 * The legacy wizard had a well-built ErrorDisplay.jsx for exactly this —
 * structured errors with a title, recovery hint, and retry/resume actions —
 * but it was never added to index.html's script list, so every screen fell
 * back to a plain string banner instead. This is that component, actually
 * wired in everywhere the wizard shows an error.
 */
export function ErrorBanner({ error, onRetry, onResume, onDismiss }: ErrorBannerProps) {
  const formatted = formatCutoverError(error);
  if (!formatted) return null;

  const isWarning = formatted.code === "PARTIAL_SUCCESS";

  return (
    <div
      className={`rounded-md border p-4 ${
        isWarning
          ? "border-(--color-warning) bg-(--color-warning-bg)"
          : "border-(--color-destructive) bg-(--color-destructive-bg)"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <strong className={isWarning ? "text-(--color-warning)" : "text-(--color-destructive)"}>{formatted.title}</strong>
        {onDismiss && (
          <button onClick={onDismiss} aria-label="Dismiss" className="text-(--color-ink-muted) hover:text-(--color-ink)">
            ×
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-(--color-ink)">{formatted.message}</p>
      {formatted.recoveryAction && <p className="mt-1 text-xs italic text-(--color-ink-tertiary)">{formatted.recoveryAction}</p>}
      {formatted.code && formatted.code !== "UNKNOWN_ERROR" && (
        <p className="mt-1 text-xs text-(--color-ink-muted)">Error code: {formatted.code}</p>
      )}
      {(onRetry || onResume) && (
        <div className="mt-3 flex gap-2">
          {formatted.canRetry && onRetry && (
            <button
              onClick={onRetry}
              className="rounded-sm bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover)"
            >
              Try again
            </button>
          )}
          {formatted.canResume && onResume && (
            <button
              onClick={onResume}
              className="rounded-sm bg-(--color-success) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast)"
            >
              Resume session
            </button>
          )}
        </div>
      )}
    </div>
  );
}
