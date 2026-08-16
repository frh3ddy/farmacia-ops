import { createPortal } from "react-dom";
import type { ExtractionSessionSummary } from "../../../lib/cutover/types";

type SessionSelectorModalProps = {
  show: boolean;
  sessions: ExtractionSessionSummary[];
  currentBatchSize: number;
  onResume: (sessionId: string) => void;
  onStartNew: () => void;
  onClose: () => void;
};

function projectBatches(session: ExtractionSessionSummary, newBatchSize: number) {
  if (!newBatchSize || newBatchSize === session.batchSize) {
    return { currentBatch: session.currentBatch, totalBatches: session.totalBatches, batchSize: session.batchSize };
  }
  const processed = session.processedItems ?? 0;
  const remaining = (session.totalItems ?? 0) - processed;
  return {
    currentBatch: processed > 0 ? Math.ceil(processed / newBatchSize) : 1,
    totalBatches: Math.ceil(remaining / newBatchSize),
    batchSize: newBatchSize,
  };
}

export function SessionSelectorModal({ show, sessions, currentBatchSize, onResume, onStartNew, onClose }: SessionSelectorModalProps) {
  if (!show) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-lg border border-(--color-border-emphasis) bg-(--color-surface-raised) p-6">
        <h3 className="mb-4 text-lg font-semibold text-(--color-ink)">Resume existing session or start new?</h3>

        {sessions.length > 0 && (
          <div className="mb-5">
            <h4 className="mb-2 text-sm font-semibold text-(--color-ink-secondary)">In-progress sessions ({sessions.length})</h4>
            <div className="max-h-72 overflow-auto rounded-md border border-(--color-border-standard)">
              {sessions.map(session => {
                const projected = projectBatches(session, currentBatchSize);
                const batchSizeChanged = currentBatchSize && currentBatchSize !== session.batchSize;
                return (
                  <button
                    key={session.id}
                    onClick={() => onResume(session.id)}
                    className="flex w-full items-center justify-between border-b border-(--color-border-subtle) px-4 py-3 text-left last:border-b-0 hover:bg-(--color-surface)"
                  >
                    <div>
                      <div className="text-sm font-medium text-(--color-ink)">
                        Session from {new Date(session.createdAt).toLocaleString()}
                      </div>
                      <div className="mt-0.5 text-xs text-(--color-ink-tertiary)">
                        Batch {projected.currentBatch} of {projected.totalBatches ?? "?"} · {session.processedItems}/{session.totalItems}{" "}
                        items processed
                        {batchSizeChanged && <span className="ml-1 text-(--color-accent)">(with batch size {projected.batchSize})</span>}
                      </div>
                    </div>
                    <span className="rounded-sm bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-contrast)">
                      Resume
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onStartNew}
            className="rounded-sm border border-(--color-border-standard) px-4 py-2 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
          >
            Start new session
          </button>
          <button onClick={onClose} className="rounded-sm px-4 py-2 text-sm text-(--color-ink-tertiary) hover:text-(--color-ink)">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
