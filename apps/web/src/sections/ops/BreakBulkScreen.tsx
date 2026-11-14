import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import { useAuth } from "../../lib/auth/AuthContext";

export type ProductOption = {
  id: string;
  name: string;
  sku: string | null;
  quantity: number | null;
  looseProductId: string | null;
};

type ProductListResponse = { success: boolean; data: ProductOption[] };

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";
const labelClass = "mb-2 block text-sm font-medium text-(--color-ink-secondary)";

/** Debounced name/SKU search over GET /products, pick one result. */
export function ProductPicker({
  label,
  selected,
  onSelect,
  placeholder,
  locationId,
}: {
  /** The store whose stock and links the results show; the session's when left out. */
  locationId?: string;
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
      apiFetch<ProductListResponse>(`/products?search=${encodeURIComponent(trimmed)}&limit=8${locationId ? `&locationId=${locationId}` : ""}`, {
        signal: controller.signal,
      })
        .then(body => setResults(body.data))
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
        })
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, locationId]);

  return (
    <div>
      <label className={labelClass}>{label}</label>
      {selected ? (
        <div className="flex items-center justify-between rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm">
          <div>
            <p className="text-(--color-ink)">{selected.name}</p>
            <p className="text-xs text-(--color-ink-tertiary)">
              {selected.sku ? `SKU ${selected.sku}` : "Sin SKU"}
              {selected.quantity != null && ` · cantidad ${selected.quantity}`}
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
                    {p.quantity != null && ` · cantidad ${p.quantity}`}
                    {p.looseProductId && " · ya vinculado"}
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

function LinkProductsCard({ locationId, locationName }: { locationId: string; locationName: string }) {
  const [boxProduct, setBoxProduct] = useState<ProductOption | null>(null);
  const [looseProduct, setLooseProduct] = useState<ProductOption | null>(null);
  const [quantity, setQuantity] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (boxProduct?.quantity != null) setQuantity(String(boxProduct.quantity));
  }, [boxProduct]);

  const handleSubmit = async () => {
    setError(null);
    setSuccessMessage(null);
    if (!boxProduct || !looseProduct) {
      setError("Elige el producto de caja y el producto suelto");
      return;
    }
    const quantityNum = quantity.trim() ? parseInt(quantity, 10) : undefined;
    if (boxProduct.quantity == null && !quantityNum) {
      setError("Este producto no tiene cantidad (piezas por caja) — indícala");
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch(`/products/${boxProduct.id}/loose-link`, {
        method: "PATCH",
        body: JSON.stringify({ looseProductId: looseProduct.id, quantity: quantityNum, locationId }),
      });
      setSuccessMessage(`"${boxProduct.name}" vinculado con "${looseProduct.name}".`);
      setBoxProduct(null);
      setLooseProduct(null);
      setQuantity("");
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
        <p className="mt-1 text-xs font-medium text-(--color-ink-secondary)">
          Se vincula solo en {locationName}; cada sucursal elige su propio suelto.
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

      <ProductPicker locationId={locationId} label="Producto de caja" selected={boxProduct} onSelect={setBoxProduct} placeholder="Paracetamol 500mg Caja…" />
      <ProductPicker locationId={locationId} label="Producto suelto" selected={looseProduct} onSelect={setLooseProduct} placeholder="Paracetamol 500mg Suelto…" />

      <div>
        <label className={labelClass}>Cantidad (piezas por caja)</label>
        <input
          value={quantity}
          onChange={e => setQuantity(e.target.value)}
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

function BreakBulkCard({ locationId }: { locationId: string }) {
  const [boxProduct, setBoxProduct] = useState<ProductOption | null>(null);
  const [boxQuantity, setBoxQuantity] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ looseUnitsCreated: number; costPerLooseUnit: number } | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setResult(null);
    if (!boxProduct) {
      setError("Elige el producto de caja a abrir");
      return;
    }
    if (!boxProduct.looseProductId) {
      setError("Este producto no está vinculado a un producto suelto — vincúlalo primero");
      return;
    }
    const quantity = parseInt(boxQuantity, 10);
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
        body: JSON.stringify({ boxProductId: boxProduct.id, boxQuantity: quantity, locationId }),
      });
      setResult(body.data);
      setBoxProduct(null);
      setBoxQuantity("");
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

      <ProductPicker locationId={locationId} label="Producto de caja" selected={boxProduct} onSelect={setBoxProduct} placeholder="Paracetamol 500mg Caja…" />

      {boxProduct && !boxProduct.looseProductId && (
        <p className="text-xs text-(--color-warning)">
          Este producto no tiene un producto suelto vinculado — vincúlalo arriba primero.
        </p>
      )}

      <div>
        <label className={labelClass}>Cajas a abrir</label>
        <input
          value={boxQuantity}
          onChange={e => setBoxQuantity(e.target.value)}
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

type AutomaticOpening = {
  kind: "opened" | "covered";
  at: string;
  productName: string;
  quantity: number;
  paymentId?: string;
  why?: string;
};

/** Boxes sales opened, and shortfalls covered without one: what to check on the shelf. */
function AutomaticOpeningsCard({ locationId }: { locationId: string }) {
  const [rows, setRows] = useState<AutomaticOpening[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true; // a store picked since this request ignores its answer
    setRows(null);
    setError(null);
    apiFetch<{ data: AutomaticOpening[] }>(`/inventory/break-bulk/automatic?locationId=${locationId}`)
      .then((body) => current && setRows(body.data))
      .catch((e) => current && setError(e instanceof ApiError ? e.message : "No se pudo cargar la lista"));
    return () => {
      current = false;
    };
  }, [locationId]);

  return (
    <div className="space-y-3 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
      <div>
        <h2 className="text-sm font-semibold text-(--color-ink)">Por ventas</h2>
        <p className="mt-1 text-xs text-(--color-ink-tertiary)">
          Cajas que una venta abrió sola, y sueltos que faltaron sin poder abrir caja. Si alguna no cuadra con el anaquel, corrígela con un ajuste.
        </p>
      </div>
      {error && <p className="text-sm text-(--color-destructive)">{error}</p>}
      {rows?.length === 0 && <p className="text-sm text-(--color-ink-tertiary)">Ninguna todavía.</p>}
      <ul className="divide-y divide-(--color-border-standard)">
        {rows?.map((r, i) => (
          <li key={i} className="py-2 text-sm">
            <p className="text-(--color-ink)">
              {r.kind === "opened"
                ? `Abrió ${r.quantity} ${r.quantity === 1 ? "caja" : "cajas"} de ${r.productName}`
                : `Faltaron ${r.quantity} de ${r.productName} sin abrir caja: ${r.why}`}
            </p>
            <p className="text-xs text-(--color-ink-tertiary)">
              <span>Venta {r.paymentId}</span> · {new Date(r.at).toLocaleString("es-MX")}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Sueltos at one store: the session's, or another one an owner picks (only an owner may work at another store). */
export function BreakBulkScreen() {
  const { user } = useAuth();
  const [locationId, setLocationId] = useState(user.currentLocation?.locationId ?? "");
  const stores = user.accessibleLocations ?? [];
  const locationName = stores.find((l) => l.locationId === locationId)?.locationName ?? user.currentLocation?.locationName ?? "esta sucursal";
  const canPick = user.currentLocation?.role === "OWNER" && stores.length > 1;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-(--color-ink)">Sueltos</h1>
        {canPick && (
          <select
            aria-label="Sucursal"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-1.5 text-sm text-(--color-ink)"
          >
            {stores.map((l) => (
              <option key={l.locationId} value={l.locationId}>
                {l.locationName}
              </option>
            ))}
          </select>
        )}
      </div>
      {/* Keyed by store, so a product picked at one store isn't carried to another */}
      <LinkProductsCard key={`link-${locationId}`} locationId={locationId} locationName={locationName} />
      <BreakBulkCard key={`break-${locationId}`} locationId={locationId} />
      <AutomaticOpeningsCard locationId={locationId} />
    </div>
  );
}
