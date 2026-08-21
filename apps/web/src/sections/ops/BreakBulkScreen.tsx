import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";

type ProductOption = {
  id: string;
  name: string;
  sku: string | null;
  cantidad: number | null;
  sueltoProductId: string | null;
};

type ProductListResponse = { success: boolean; data: ProductOption[] };

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";
const labelClass = "mb-2 block text-sm font-medium text-(--color-ink-secondary)";

/** Debounced name/SKU search over GET /products, pick one result. */
function ProductPicker({
  label,
  selected,
  onSelect,
  placeholder,
}: {
  label: string;
  selected: ProductOption | null;
  onSelect: (product: ProductOption) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      apiFetch<ProductListResponse>(`/products?search=${encodeURIComponent(trimmed)}&limit=8`, {
        signal: controller.signal,
      })
        .then(body => setResults(body.data))
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
        })
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div>
      <label className={labelClass}>{label}</label>
      {selected ? (
        <div className="flex items-center justify-between rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm">
          <div>
            <p className="text-(--color-ink)">{selected.name}</p>
            <p className="text-xs text-(--color-ink-tertiary)">
              {selected.sku ? `SKU ${selected.sku}` : "Sin SKU"}
              {selected.cantidad != null && ` · cantidad ${selected.cantidad}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              onSelect(null as unknown as ProductOption);
              setQuery("");
            }}
            className="text-xs text-(--color-accent) hover:underline"
          >
            Cambiar
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={placeholder ?? "Buscar por nombre o SKU…"}
            className={inputClass}
          />
          {loading && <p className="mt-1 text-xs text-(--color-ink-tertiary)">Buscando…</p>}
          {!loading && results.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface) shadow-md">
              {results.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onSelect(p);
                    setQuery("");
                    setResults([]);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-(--color-surface-inset)"
                >
                  <p className="text-(--color-ink)">{p.name}</p>
                  <p className="text-xs text-(--color-ink-tertiary)">
                    {p.sku ? `SKU ${p.sku}` : "Sin SKU"}
                    {p.cantidad != null && ` · cantidad ${p.cantidad}`}
                    {p.sueltoProductId && " · ya vinculado"}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LinkProductsCard() {
  const [caja, setCaja] = useState<ProductOption | null>(null);
  const [suelto, setSuelto] = useState<ProductOption | null>(null);
  const [cantidad, setCantidad] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (caja?.cantidad != null) setCantidad(String(caja.cantidad));
  }, [caja]);

  const handleSubmit = async () => {
    setError(null);
    setSuccessMessage(null);
    if (!caja || !suelto) {
      setError("Elige el producto de caja y el producto suelto");
      return;
    }
    const cantidadNum = cantidad.trim() ? parseInt(cantidad, 10) : undefined;
    if (caja.cantidad == null && !cantidadNum) {
      setError("Este producto no tiene cantidad (piezas por caja) — indícala");
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch(`/products/${caja.id}/suelto-link`, {
        method: "PATCH",
        body: JSON.stringify({ sueltoProductId: suelto.id, cantidad: cantidadNum }),
      });
      setSuccessMessage(`"${caja.name}" vinculado con "${suelto.name}".`);
      setCaja(null);
      setSuelto(null);
      setCantidad("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo vincular");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
      <div>
        <h2 className="text-sm font-semibold text-(--color-ink)">Vincular caja con suelto</h2>
        <p className="mt-1 text-xs text-(--color-ink-tertiary)">
          Ambos productos ya existen por separado en Square — esto solo los relaciona aquí para poder abrir cajas.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-3 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="rounded-md border border-(--color-success) bg-(--color-success-bg) px-3 py-2 text-sm text-(--color-success)">
          {successMessage}
        </div>
      )}

      <ProductPicker label="Producto de caja" selected={caja} onSelect={setCaja} placeholder="Paracetamol 500mg Caja…" />
      <ProductPicker label="Producto suelto" selected={suelto} onSelect={setSuelto} placeholder="Paracetamol 500mg Suelto…" />

      <div>
        <label className={labelClass}>Cantidad (piezas por caja)</label>
        <input
          value={cantidad}
          onChange={e => setCantidad(e.target.value)}
          type="number"
          min={1}
          placeholder="20"
          className={inputClass}
        />
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full rounded-sm bg-(--color-accent) py-2 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Vinculando…" : "Vincular"}
      </button>
    </div>
  );
}

function BreakBulkCard() {
  const [caja, setCaja] = useState<ProductOption | null>(null);
  const [cajaQuantity, setCajaQuantity] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ looseUnitsCreated: number; costPerLooseUnit: number } | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setResult(null);
    if (!caja) {
      setError("Elige el producto de caja a abrir");
      return;
    }
    if (!caja.sueltoProductId) {
      setError("Este producto no está vinculado a un producto suelto — vincúlalo primero");
      return;
    }
    const quantity = parseInt(cajaQuantity, 10);
    if (isNaN(quantity) || quantity <= 0) {
      setError("Indica cuántas cajas vas a abrir");
      return;
    }

    setSubmitting(true);
    try {
      const body = await apiFetch<{
        data: { looseUnitsCreated: number; costPerLooseUnit: number };
      }>("/inventory/break-bulk", {
        method: "POST",
        body: JSON.stringify({ cajaProductId: caja.id, cajaQuantity: quantity }),
      });
      setResult(body.data);
      setCaja(null);
      setCajaQuantity("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo abrir la caja");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
      <div>
        <h2 className="text-sm font-semibold text-(--color-ink)">Abrir caja</h2>
        <p className="mt-1 text-xs text-(--color-ink-tertiary)">
          Convierte N cajas en piezas sueltas del producto vinculado, preservando el costo exacto.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-3 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}
      {result && (
        <div className="rounded-md border border-(--color-success) bg-(--color-success-bg) px-3 py-2 text-sm text-(--color-success)">
          Se crearon {result.looseUnitsCreated} piezas sueltas a ${result.costPerLooseUnit.toFixed(4)} c/u.
        </div>
      )}

      <ProductPicker label="Producto de caja" selected={caja} onSelect={setCaja} placeholder="Paracetamol 500mg Caja…" />

      {caja && !caja.sueltoProductId && (
        <p className="text-xs text-(--color-warning)">
          Este producto no tiene un producto suelto vinculado — vincúlalo arriba primero.
        </p>
      )}

      <div>
        <label className={labelClass}>Cajas a abrir</label>
        <input
          value={cajaQuantity}
          onChange={e => setCajaQuantity(e.target.value)}
          type="number"
          min={1}
          placeholder="1"
          className={inputClass}
        />
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full rounded-sm bg-(--color-accent) py-2 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Abriendo…" : "Abrir caja"}
      </button>
    </div>
  );
}

export function BreakBulkScreen() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-(--color-ink)">Sueltos</h1>
      <LinkProductsCard />
      <BreakBulkCard />
    </div>
  );
}
