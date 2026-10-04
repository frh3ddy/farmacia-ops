import type { MigrationResult } from "../../../lib/cutover/types";

function exportErrorsToCSV(reportData: MigrationResult) {
  if (!reportData.errors || reportData.errors.length === 0) return;
  const rows = [
    ["Producto", "Mensaje de error", "Recomendación"],
    ...reportData.errors.map(err => [err.productName || err.productId || "", err.message || "", err.recommendation || ""]),
  ];
  const csv = rows.map(row => row.map(cell => `"${cell}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "errores-migracion.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportPhase({ reportData }: { reportData: MigrationResult }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="rounded-md border border-(--color-success) bg-(--color-success-bg) p-6">
        <h2 className="text-xl font-bold text-(--color-success)">Migración terminada</h2>
        <div className="tabular mt-4 grid grid-cols-3 gap-4">
          <div>
            <div className="text-2xl font-bold text-(--color-success)">{reportData.productsProcessed || 0}</div>
            <div className="text-sm text-(--color-ink-secondary)">Productos migrados</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-(--color-destructive)">{reportData.errors?.length || 0}</div>
            <div className="text-sm text-(--color-ink-secondary)">Errores</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-(--color-warning)">{reportData.skippedItems || 0}</div>
            <div className="text-sm text-(--color-ink-secondary)">Omitidos</div>
          </div>
        </div>
      </div>

      {reportData.errors && reportData.errors.length > 0 && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-(--color-ink)">Lista de errores</h3>
            <button
              onClick={() => exportErrorsToCSV(reportData)}
              className="rounded-sm border border-(--color-border-standard) px-4 py-2 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
            >
              Descargar reporte de errores (CSV)
            </button>
          </div>
          <div className="overflow-x-auto rounded-md border border-(--color-border-standard)">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-(--color-border-standard) bg-(--color-surface)">
                  <th className="px-4 py-2 text-left font-medium text-(--color-ink-secondary)">Producto</th>
                  <th className="px-4 py-2 text-left font-medium text-(--color-ink-secondary)">Mensaje de error</th>
                  <th className="px-4 py-2 text-left font-medium text-(--color-ink-secondary)">Recomendación</th>
                </tr>
              </thead>
              <tbody>
                {reportData.errors.map((err, idx) => (
                  <tr key={idx} className="border-b border-(--color-border-subtle) last:border-b-0">
                    <td className="px-4 py-2 text-(--color-ink)">{err.productName || err.productId || "—"}</td>
                    <td className="px-4 py-2 text-(--color-ink-secondary)">{err.message || "—"}</td>
                    <td className="px-4 py-2 text-(--color-ink-secondary)">{err.recommendation || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
