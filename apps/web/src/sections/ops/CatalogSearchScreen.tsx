import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";

type MedicationType = "GENERICO" | "DE_MARCA" | "SIMILAR" | null;

type CatalogProduct = {
  id: string;
  name: string;
  sku: string | null;
  medicationType: MedicationType;
  medicationDefinitionId: string | null;
  laboratoryName: string | null;
  presentation: string | null;
  requiresPrescription: boolean;
  isControlled: boolean;
  price: number | null;
  currency: string;
  quantity: number;
  inStock: boolean;
};

type SearchResponse = {
  success: boolean;
  requested: CatalogProduct[];
  alternatives: CatalogProduct[];
  alternativesChecked: boolean;
};

const MEDICATION_TYPE_LABEL: Record<Exclude<MedicationType, null>, string> = {
  GENERICO: "Genérico",
  DE_MARCA: "Marca",
  SIMILAR: "Similar",
};

function StockBadge({ inStock }: { inStock: boolean }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
        inStock
          ? "border-(--color-success) bg-(--color-success-bg) text-(--color-success)"
          : "border-(--color-destructive) bg-(--color-destructive-bg) text-(--color-destructive)"
      }`}
    >
      {inStock ? "En stock" : "Sin existencias"}
    </span>
  );
}

function ProductCard({ product, highlighted }: { product: CatalogProduct; highlighted?: boolean }) {
  return (
    <div
      className={`rounded-md border p-4 ${
        highlighted
          ? "border-(--color-border-standard) bg-(--color-surface-raised)"
          : "border-(--color-border-standard) bg-(--color-surface)"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-(--color-ink)">{product.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-(--color-ink-tertiary)">
            {product.medicationType && (
              <span className="rounded-full bg-(--color-accent)/10 px-2 py-0.5 font-medium text-(--color-accent)">
                {MEDICATION_TYPE_LABEL[product.medicationType]}
              </span>
            )}
            {product.laboratoryName && <span>{product.laboratoryName}</span>}
            {product.presentation && <span>· {product.presentation}</span>}
            {product.sku && <span>· SKU {product.sku}</span>}
          </div>
          {(product.requiresPrescription || product.isControlled) && (
            <p className="mt-1 text-xs text-(--color-warning)">
              {[product.requiresPrescription && "Requiere receta", product.isControlled && "Sustancia controlada"]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          {product.price != null && (
            <p className="tabular font-semibold text-(--color-ink)">${product.price.toFixed(2)}</p>
          )}
          <div className="mt-1">
            <StockBadge inStock={product.inStock} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function CatalogSearchScreen() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      apiFetch<SearchResponse>(`/products/catalog-search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then(setResult)
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(err instanceof ApiError ? err.message : "Search failed");
        })
        .finally(() => setLoading(false));
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const requestedOutOfStock = result != null && result.alternativesChecked;
  const requestedBrandName = requestedOutOfStock ? result!.requested[0]?.name : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold text-(--color-ink)">Buscar producto</h1>
      <p className="text-sm text-(--color-ink-tertiary)">
        Busca por marca, genérico, principio activo o SKU. Si la marca solicitada no está disponible, se muestran
        alternativas equivalentes.
      </p>

      <input
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Tylenol 500…"
        className="w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2.5 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
      />

      {error && (
        <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-(--color-ink-tertiary)">Buscando…</p>}

      {!loading && result && result.requested.length === 0 && (
        <p className="text-sm text-(--color-ink-tertiary)">No se encontraron resultados para "{query.trim()}".</p>
      )}

      {!loading && result && result.requested.length > 0 && (
        <div className="space-y-4">
          <div className="space-y-2">
            {requestedOutOfStock && (
              <p className="text-sm text-(--color-warning)">
                No tenemos {requestedBrandName} disponible
                {result!.alternatives.length > 0 ? ", pero tenemos alternativas equivalentes:" : "."}
              </p>
            )}
            {result.requested.map(p => (
              <ProductCard key={p.id} product={p} highlighted />
            ))}
          </div>

          {requestedOutOfStock && result.alternatives.length === 0 && (
            <p className="text-sm text-(--color-ink-tertiary)">No hay alternativas equivalentes disponibles.</p>
          )}

          {result.alternatives.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-tertiary)">
                Alternativas equivalentes
              </p>
              {result.alternatives.map(p => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
