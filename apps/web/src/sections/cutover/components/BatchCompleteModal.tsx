type BatchCompleteModalProps = {
  show: boolean;
  loading: boolean;
  onContinue: () => void;
  onReview: () => void;
  onPause: () => void;
};

// Deliberately not portaled to document.body — see Modal.tsx's comment on why.
export function BatchCompleteModal({ show, loading, onContinue, onReview, onPause }: BatchCompleteModalProps) {
  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-(--color-border-emphasis) bg-(--color-surface-raised) p-6">
        <h3 className="mb-2 text-lg font-semibold text-(--color-ink)">Bloque terminado</h3>
        <p className="mb-4 text-sm text-(--color-ink-tertiary)">Ya revisaste todos los productos de este bloque. Elige qué hacer:</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onContinue}
            disabled={loading}
            className="w-full rounded-sm bg-(--color-accent) py-2 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:opacity-50"
          >
            {loading ? "Cargando…" : "Continuar con el siguiente bloque"}
          </button>
          <button
            onClick={onReview}
            disabled={loading}
            className="w-full rounded-sm bg-(--color-success) py-2 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
          >
            Revisar e iniciar migración
          </button>
          <button
            onClick={onPause}
            className="w-full rounded-sm border border-(--color-border-standard) py-2 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
          >
            Volver a la configuración
          </button>
        </div>
      </div>
    </div>
  );
}
