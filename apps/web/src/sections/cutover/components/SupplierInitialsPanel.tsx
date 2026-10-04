type SupplierInitialsPanelProps = {
  supplierInitialsMap: Record<string, string[]>;
  onClear: () => void;
  onRemove: (supplierName: string) => void;
};

export function SupplierInitialsPanel({ supplierInitialsMap, onClear, onRemove }: SupplierInitialsPanelProps) {
  const entries = Object.entries(supplierInitialsMap);
  if (entries.length === 0) return null;

  return (
    <div className="rounded-md border border-(--color-accent) bg-(--color-accent)/5 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-(--color-accent)">Iniciales de proveedor aprendidas ({entries.length})</h4>
        <button onClick={onClear} className="text-xs font-medium text-(--color-accent) hover:text-(--color-accent-hover)">
          Borrar todo
        </button>
      </div>
      <div className="space-y-2">
        {entries.map(([supplierName, initials]) => (
          <div
            key={supplierName}
            className="flex items-center justify-between rounded-sm border border-(--color-border-subtle) bg-(--color-surface-raised) p-2"
          >
            <div className="text-sm">
              <span className="font-medium text-(--color-ink)">{supplierName}:</span>{" "}
              <span className="text-(--color-ink-secondary)">{initials.join(", ")}</span>
            </div>
            <button onClick={() => onRemove(supplierName)} className="ml-2 text-xs text-(--color-destructive) hover:opacity-80">
              Quitar
            </button>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-(--color-accent)">Se guardarán al aprobar productos, para identificar proveedores en futuras extracciones.</p>
    </div>
  );
}
