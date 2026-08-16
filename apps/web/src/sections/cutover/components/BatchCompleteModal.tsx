import { createPortal } from "react-dom";

type BatchCompleteModalProps = {
  show: boolean;
  loading: boolean;
  onContinue: () => void;
  onReview: () => void;
  onPause: () => void;
};

export function BatchCompleteModal({ show, loading, onContinue, onReview, onPause }: BatchCompleteModalProps) {
  if (!show) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-(--color-border-emphasis) bg-(--color-surface-raised) p-6">
        <h3 className="mb-2 text-lg font-semibold text-(--color-ink)">Batch complete</h3>
        <p className="mb-4 text-sm text-(--color-ink-tertiary)">All items in this batch have been reviewed. Choose an action:</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onContinue}
            disabled={loading}
            className="w-full rounded-sm bg-(--color-accent) py-2 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:opacity-50"
          >
            {loading ? "Loading…" : "Continue to next batch"}
          </button>
          <button
            onClick={onReview}
            disabled={loading}
            className="w-full rounded-sm bg-(--color-success) py-2 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
          >
            Review & start migration
          </button>
          <button
            onClick={onPause}
            className="w-full rounded-sm border border-(--color-border-standard) py-2 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
          >
            Pause & exit
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
