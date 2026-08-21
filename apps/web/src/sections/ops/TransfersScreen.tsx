import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";

type ProductOption = { id: string; name: string; sku: string | null };
type ProductListResponse = { success: boolean; data: ProductOption[] };

type LocationOption = { id: string; name: string };
type LocationListResponse = { success: boolean; data: LocationOption[] };

type TransferLine = {
  id: string;
  quantity: number;
  quantityReceived: number | null;
  unitCost: string;
};

type Transfer = {
  id: string;
  status: "PENDING" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  quantity: number;
  createdAt: string;
  shippedAt: string | null;
  receivedAt: string | null;
  product: { id: string; name: string; sku: string | null };
  fromLocation: { id: string; name: string };
  toLocation: { id: string; name: string };
  lines: TransferLine[];
};

type TransferListResponse = { success: boolean; data: Transfer[] };

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";
const labelClass = "mb-2 block text-sm font-medium text-(--color-ink-secondary)";

/** Debounced name/SKU search over GET /products, pick one result. */
function ProductPicker({
  selected,
  onSelect,
}: {
  selected: ProductOption | null;
  onSelect: (product: ProductOption | null) => void;
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
      <label className={labelClass}>Producto</label>
      {selected ? (
        <div className="flex items-center justify-between rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm">
          <div>
            <p className="text-(--color-ink)">{selected.name}</p>
            <p className="text-xs text-(--color-ink-tertiary)">{selected.sku ? `SKU ${selected.sku}` : "Sin SKU"}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              onSelect(null);
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
            placeholder="Buscar por nombre o SKU…"
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
                  <p className="text-xs text-(--color-ink-tertiary)">{p.sku ? `SKU ${p.sku}` : "Sin SKU"}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Transfer["status"] }) {
  const styles: Record<Transfer["status"], string> = {
    PENDING: "border-(--color-border-standard) bg-(--color-surface-inset) text-(--color-ink-secondary)",
    IN_TRANSIT: "border-(--color-warning) bg-(--color-warning-bg) text-(--color-warning)",
    RECEIVED: "border-(--color-success) bg-(--color-success-bg) text-(--color-success)",
    CANCELLED: "border-(--color-destructive) bg-(--color-destructive-bg) text-(--color-destructive)",
  };
  const labels: Record<Transfer["status"], string> = {
    PENDING: "Pendiente",
    IN_TRANSIT: "En tránsito",
    RECEIVED: "Recibido",
    CANCELLED: "Cancelado",
  };
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function CreateTransferCard({ onCreated }: { onCreated: () => void }) {
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [product, setProduct] = useState<ProductOption | null>(null);
  const [toLocationId, setToLocationId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<LocationListResponse>("/locations").then(body => setLocations(body.data)).catch(() => {});
  }, []);

  const handleSubmit = async () => {
    setError(null);
    setSuccessMessage(null);
    if (!product) {
      setError("Elige el producto a transferir");
      return;
    }
    if (!toLocationId) {
      setError("Elige la sucursal destino");
      return;
    }
    const quantityNum = parseInt(quantity, 10);
    if (isNaN(quantityNum) || quantityNum <= 0) {
      setError("Indica una cantidad válida");
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch("/transfers", {
        method: "POST",
        body: JSON.stringify({ productId: product.id, toLocationId, quantity: quantityNum }),
      });
      setSuccessMessage(`Transferencia de ${quantityNum} unidad(es) de "${product.name}" enviada.`);
      setProduct(null);
      setToLocationId("");
      setQuantity("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear la transferencia");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
      <div>
        <h2 className="text-sm font-semibold text-(--color-ink)">Nueva transferencia</h2>
        <p className="mt-1 text-xs text-(--color-ink-tertiary)">
          Envía stock desde tu sucursal actual a otra. El costo FIFO se preserva exactamente.
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

      <ProductPicker selected={product} onSelect={setProduct} />

      <div>
        <label className={labelClass}>Sucursal destino</label>
        <select value={toLocationId} onChange={e => setToLocationId(e.target.value)} className={inputClass}>
          <option value="">Elige una sucursal</option>
          {locations.map(l => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelClass}>Cantidad</label>
        <input
          value={quantity}
          onChange={e => setQuantity(e.target.value)}
          type="number"
          min={1}
          placeholder="10"
          className={inputClass}
        />
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full rounded-sm bg-(--color-accent) py-2 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Enviando…" : "Enviar transferencia"}
      </button>
    </div>
  );
}

function ReceiveRow({ transfer, onReceived }: { transfer: Transfer; onReceived: () => void }) {
  const [receiving, setReceiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One editable quantity-received input per line, defaulting to quantity shipped.
  const [overrides, setOverrides] = useState<Record<string, string>>(() =>
    Object.fromEntries(transfer.lines.map(l => [l.id, String(l.quantity)])),
  );

  const handleReceive = async () => {
    setError(null);
    setReceiving(true);
    try {
      const lineReceipts = transfer.lines.map(l => ({
        transferLineId: l.id,
        quantityReceived: parseInt(overrides[l.id], 10) || 0,
      }));
      await apiFetch(`/transfers/${transfer.id}/receive`, {
        method: "POST",
        body: JSON.stringify({ lineReceipts }),
      });
      onReceived();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo recibir la transferencia");
    } finally {
      setReceiving(false);
    }
  };

  return (
    <div className="rounded-md border border-(--color-border-standard) bg-(--color-surface) p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-(--color-ink)">{transfer.product.name}</p>
          <p className="mt-0.5 text-xs text-(--color-ink-tertiary)">
            {transfer.fromLocation.name} → {transfer.toLocation.name} · {transfer.quantity} unidad(es)
          </p>
        </div>
        <StatusBadge status={transfer.status} />
      </div>

      {error && <p className="mt-2 text-xs text-(--color-destructive)">{error}</p>}

      <div className="mt-3 space-y-2">
        {transfer.lines.map(line => (
          <div key={line.id} className="flex items-center gap-2 text-xs text-(--color-ink-secondary)">
            <span className="flex-1">
              Lote de {line.quantity} @ ${Number(line.unitCost).toFixed(4)}/u
            </span>
            <input
              value={overrides[line.id] ?? ""}
              onChange={e => setOverrides(prev => ({ ...prev, [line.id]: e.target.value }))}
              type="number"
              min={0}
              max={line.quantity}
              className="w-20 rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-2 py-1 text-xs text-(--color-ink)"
            />
            <span>recibido</span>
          </div>
        ))}
      </div>

      <button
        onClick={handleReceive}
        disabled={receiving}
        className="mt-3 w-full rounded-sm border border-(--color-border-standard) py-1.5 text-sm font-medium text-(--color-ink) hover:bg-(--color-surface-inset) disabled:cursor-not-allowed disabled:opacity-50"
      >
        {receiving ? "Recibiendo…" : "Recibir"}
      </button>
    </div>
  );
}

export function TransfersScreen() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTransfers = () => {
    setLoading(true);
    apiFetch<TransferListResponse>("/transfers")
      .then(body => setTransfers(body.data))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to load transfers"))
      .finally(() => setLoading(false));
  };

  useEffect(loadTransfers, []);

  const pending = transfers.filter(t => t.status === "IN_TRANSIT");
  const others = transfers.filter(t => t.status !== "IN_TRANSIT");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-(--color-ink)">Transferencias entre sucursales</h1>

      <CreateTransferCard onCreated={loadTransfers} />

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-(--color-ink)">En tránsito</h2>
        {error && <p className="text-sm text-(--color-destructive)">{error}</p>}
        {loading && <p className="text-sm text-(--color-ink-tertiary)">Cargando…</p>}
        {!loading && pending.length === 0 && (
          <p className="text-sm text-(--color-ink-tertiary)">No hay transferencias en tránsito.</p>
        )}
        {pending.map(t => (
          <ReceiveRow key={t.id} transfer={t} onReceived={loadTransfers} />
        ))}
      </div>

      {others.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-(--color-ink)">Historial</h2>
          {others.map(t => (
            <div key={t.id} className="flex items-center justify-between rounded-md border border-(--color-border-standard) bg-(--color-surface) px-4 py-2 text-sm">
              <div>
                <p className="text-(--color-ink)">{t.product.name}</p>
                <p className="text-xs text-(--color-ink-tertiary)">
                  {t.fromLocation.name} → {t.toLocation.name} · {t.quantity} unidad(es)
                </p>
              </div>
              <StatusBadge status={t.status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
