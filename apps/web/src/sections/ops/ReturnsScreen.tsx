import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";

type SaleItem = { id: string; quantity: number; price: string; product: { name: string }; returns: { quantity: number }[] };
type RecentSale = { id: string; createdAt: string; totalRevenue: string; location: { name: string }; items: SaleItem[] };
type SaleReturn = {
  id: string;
  returnedAt: string;
  reason: string | null;
  revenue: string;
  returnedByName: string | null;
  sale: { location: { name: string } };
  items: { id: string; quantity: number; saleItem: { product: { name: string } }; adjustment: { squareSynced: boolean; squareSyncError: string | null } }[];
};

const left = (item: SaleItem) => item.quantity - item.returns.reduce((n, r) => n + r.quantity, 0);
const dateTime = (iso: string) => new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });

/** Customer returns by hand: pick a sale from the last 3 days, the units coming back, and why. */
export function ReturnsScreen() {
  const [sales, setSales] = useState<RecentSale[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ data: RecentSale[] }>("/api/sales/recent")
      .then(body => setSales(body.data))
      .catch(err => setError(err instanceof ApiError ? err.message : "No se pudieron cargar las ventas"));
  }, []);

  if (error) return <p className="text-sm text-(--color-destructive)">{error}</p>;
  if (!sales) return <p className="text-sm text-(--color-ink-tertiary)">Cargando…</p>;

  // The worker records the return in a moment; count it here right away.
  const returned = (saleId: string, items: Record<string, number>) =>
    setSales(sales.map(s => (s.id !== saleId ? s : {
      ...s,
      items: s.items.map(i => (items[i.id] ? { ...i, returns: [...i.returns, { quantity: items[i.id] }] } : i)),
    })));

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold text-(--color-ink)">Devoluciones</h1>
      <p className="mb-4 text-sm text-(--color-ink-secondary)">
        Ventas de los últimos 3 días. Lo devuelto regresa a la existencia y se descuenta de la venta.
      </p>
      {sales.length === 0 ? (
        <p className="text-sm text-(--color-ink-tertiary)">No hay ventas recientes.</p>
      ) : (
        <ul className="divide-y divide-(--color-border-standard) rounded-md border border-(--color-border-standard) bg-(--color-surface-raised)">
          {sales.map(s => (
            <li key={s.id} className="p-3">
              <button
                onClick={() => setOpenId(openId === s.id ? null : s.id)}
                className="flex w-full items-center justify-between gap-4 text-left text-sm"
              >
                <span className="font-medium text-(--color-ink)">
                  {dateTime(s.createdAt)} · {s.location.name}
                </span>
                <span className="text-(--color-ink-tertiary)">
                  {s.items.map(i => i.product.name).join(", ")} · ${Number(s.totalRevenue).toFixed(2)}
                </span>
              </button>
              {openId === s.id && <ReturnForm sale={s} onReturned={items => returned(s.id, items)} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReturnForm({ sale, onReturned }: { sale: RecentSale; onReturned: (items: Record<string, number>) => void }) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  // One key per return, kept until it succeeds: a retry after an error records it once.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = Object.entries(quantities).filter(([, q]) => q > 0).map(([saleItemId, quantity]) => ({ saleItemId, quantity }));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/sales/${sale.id}/returns`, {
        method: "POST",
        body: JSON.stringify({ items, reason: reason.trim() || undefined, clientRequestId: requestId }),
      });
      onReturned(quantities);
      setQuantities({});
      setReason("");
      setRequestId(crypto.randomUUID());
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo registrar la devolución");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      {sale.items.map(i => (
        <label key={i.id} className="flex items-center justify-between gap-4 text-sm text-(--color-ink-secondary)">
          <span>
            {i.product.name} (quedan {left(i)})
          </span>
          <input
            type="number"
            min="0"
            max={left(i)}
            step="1"
            disabled={left(i) === 0}
            value={quantities[i.id] ?? ""}
            onChange={e => setQuantities({ ...quantities, [i.id]: Math.min(Number(e.target.value), left(i)) })}
            aria-label={`${i.product.name} (quedan ${left(i)})`}
            className="w-20 rounded-sm border border-(--color-border-standard) px-2 py-1"
          />
        </label>
      ))}
      <label className="block text-sm text-(--color-ink-secondary)">
        Motivo
        <input
          value={reason}
          onChange={e => setReason(e.target.value)}
          className="mt-1 block w-full rounded-sm border border-(--color-border-standard) px-2 py-1"
        />
      </label>
      <button
        onClick={submit}
        disabled={saving || items.length === 0}
        className="rounded-sm bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:opacity-50"
      >
        {saving ? "Registrando…" : "Registrar devolución"}
      </button>
      {done && <p className="text-sm text-(--color-ink-secondary)">Devolución registrada</p>}
      {error && <p className="text-sm text-(--color-destructive)">{error}</p>}
    </div>
  );
}

/** Every return, newest first, with who made it (owners and managers). */
export function ReturnsHistoryScreen() {
  const [returns, setReturns] = useState<SaleReturn[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ data: SaleReturn[] }>("/api/sales/returns")
      .then(body => setReturns(body.data))
      .catch(err => setError(err instanceof ApiError ? err.message : "No se pudieron cargar las devoluciones"));
  }, []);

  if (error) return <p className="text-sm text-(--color-destructive)">{error}</p>;
  if (!returns) return <p className="text-sm text-(--color-ink-tertiary)">Cargando…</p>;

  return (
    <div className="max-w-3xl">
      <h1 className="mb-4 text-xl font-semibold text-(--color-ink)">Historial de devoluciones ({returns.length})</h1>
      {returns.length === 0 ? (
        <p className="text-sm text-(--color-ink-tertiary)">Sin devoluciones.</p>
      ) : (
        <ul className="divide-y divide-(--color-border-standard) rounded-md border border-(--color-border-standard) bg-(--color-surface-raised)">
          {returns.map(r => (
            <li key={r.id} className="p-3 text-sm">
              <p className="font-medium text-(--color-ink)">
                {r.items.map(i => `${i.quantity} × ${i.saleItem.product.name}`).join(", ")} · ${Number(r.revenue).toFixed(2)}
              </p>
              <p className="text-(--color-ink-tertiary)">
                {dateTime(r.returnedAt)} · {r.sale.location.name} · {r.returnedByName ?? "—"}
                {r.reason && ` · ${r.reason}`}
              </p>
              {r.items
                .filter(i => !i.adjustment.squareSynced && i.adjustment.squareSyncError)
                .map(i => (
                  <p key={i.id} className="text-(--color-destructive)">
                    Sin actualizar en Square: {i.adjustment.squareSyncError}
                  </p>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
