import type { MigrationResult } from "../../../lib/cutover/types";

export function MigrationPhase({ migrationResult }: { migrationResult: MigrationResult | null }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h2 className="text-2xl font-bold text-(--color-ink)">Migration Execution</h2>
      <div className="rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-8 text-center">
        <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-(--color-border-standard) border-b-(--color-accent)" />
        <p className="font-medium text-(--color-ink)">Processing migration…</p>
        {migrationResult && (
          <div className="tabular mt-4 space-y-1 text-sm text-(--color-ink-secondary)">
            <p>
              Batch: {migrationResult.currentBatch} / {migrationResult.totalBatches}
            </p>
            <p>
              Processed: {migrationResult.processedItems} / {migrationResult.totalItems}
            </p>
            {!!migrationResult.skippedItems && <p className="text-(--color-warning)">Skipped: {migrationResult.skippedItems} items</p>}
          </div>
        )}
      </div>
    </div>
  );
}
