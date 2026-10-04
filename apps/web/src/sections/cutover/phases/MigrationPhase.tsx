import type { MigrationResult } from "../../../lib/cutover/types";

export function MigrationPhase({ migrationResult }: { migrationResult: MigrationResult | null }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h2 className="text-2xl font-bold text-(--color-ink)">Ejecución de la migración</h2>
      <div className="rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-8 text-center">
        <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-(--color-border-standard) border-b-(--color-accent)" />
        <p className="font-medium text-(--color-ink)">Procesando migración…</p>
        {migrationResult && (
          <div className="tabular mt-4 space-y-1 text-sm text-(--color-ink-secondary)">
            <p>
              Bloque: {migrationResult.currentBatch} / {migrationResult.totalBatches}
            </p>
            <p>
              Procesados: {migrationResult.processedItems} / {migrationResult.totalItems}
            </p>
            {!!migrationResult.skippedItems && <p className="text-(--color-warning)">Omitidos: {migrationResult.skippedItems} productos</p>}
          </div>
        )}
      </div>
    </div>
  );
}
