import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import { ProductPicker, type ProductOption } from "./BreakBulkScreen";

type UnmatchedLine = {
  id: string;
  description: string | null;
  quantity: number;
  amount: string;
  sale: { createdAt: string; location: { id: string; name: string } };
};

/**
 * Square custom amounts (sold with no catalog item). Their revenue is already
 * counted; assigning a product takes its stock and cost the way the sale would
 * have. The worker does it, so a row leaves the list before its cost lands.
 */
export function UnmatchedLinesScreen() {
  const [lines, setLines] = useState<UnmatchedLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ data: UnmatchedLine[] }>("/api/sales/unmatched-lines")
      .then(body => setLines(body.data))
      .catch(err => setError(err instanceof ApiError ? err.message : "No se pudieron cargar los montos"));
  }, []);

  if (error) return <p className="text-sm text-(--color-destructive)">{error}</p>;
  if (!lines) return <p className="text-sm text-(--color-ink-tertiary)">Cargando…</p>;

  const remove = (id: string) => {
    setLines(lines.filter(l => l.id !== id));
    setOpenId(null);
  };

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold text-(--color-ink)">Montos sin producto ({lines.length})</h1>
      <p className="mb-4 text-sm text-(--color-ink-secondary)">
        Ventas cobradas en Square como monto personalizado. Asigna el producto que se vendió para descontar su
        existencia y registrar su costo.
      </p>
      {lines.length === 0 ? (
        <p className="text-sm text-(--color-ink-tertiary)">Todos los montos tienen producto.</p>
      ) : (
        <ul className="divide-y divide-(--color-border-standard) rounded-md border border-(--color-border-standard) bg-(--color-surface-raised)">
          {lines.map(l => (
            <li key={l.id} className="p-3">
              <button
                onClick={() => setOpenId(openId === l.id ? null : l.id)}
                className="flex w-full items-center justify-between gap-4 text-left text-sm"
              >
                <span className="font-medium text-(--color-ink)">{l.description ?? "Sin descripción"}</span>
                <span className="text-(--color-ink-tertiary)">
                  {l.quantity} × ${(Number(l.amount) / l.quantity).toFixed(2)} · {l.sale.location.name} ·{" "}
                  {new Date(l.sale.createdAt).toLocaleDateString("es-MX")}
                </span>
              </button>
              {openId === l.id && <MatchForm line={l} onMatched={() => remove(l.id)} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MatchForm({ line, onMatched }: { line: UnmatchedLine; onMatched: () => void }) {
  const [product, setProduct] = useState<ProductOption | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const match = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/sales/unmatched-lines/${line.id}/match`, {
        method: "POST",
        body: JSON.stringify({ productId: product!.id }),
      });
      onMatched();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo asignar el producto");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      <ProductPicker label="Producto vendido" selected={product} onSelect={setProduct} />
      <button
        onClick={match}
        disabled={saving || !product}
        className="rounded-sm bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
      >
        {saving ? "Asignando…" : "Asignar"}
      </button>
      {error && <p className="text-sm text-(--color-destructive)">{error}</p>}
    </div>
  );
}
