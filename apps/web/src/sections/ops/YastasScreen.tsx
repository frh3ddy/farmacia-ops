import { useEffect, useState } from "react";
import { Table, type Column } from "../../components/ui/Table";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import { useLocations } from "../../lib/useLocations";
import { useAuth } from "../../lib/auth/AuthContext";
import { isOwner } from "../../lib/auth/types";
import type { Employee, YastasOperation, YastasSettlement, YastasWallet } from "../../lib/ops/types";

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";
const labelClass = "mb-2 block text-sm font-medium text-(--color-ink-secondary)";
const cardClass = "space-y-4 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4";
const buttonClass =
  "w-full rounded-sm bg-(--color-accent) py-2 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-50";

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-3 py-2 text-sm text-(--color-destructive)">
      {message}
    </div>
  );
}

function SuccessBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-(--color-success) bg-(--color-success-bg) px-3 py-2 text-sm text-(--color-success)">
      {message}
    </div>
  );
}

/** Wallet balance + one-time opening-balance cutover, per location. */
function WalletCard({
  locationId,
  refreshKey,
  onChanged,
}: {
  locationId: string;
  refreshKey: number;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const [wallet, setWallet] = useState<YastasWallet | null>(null);
  const [notSeeded, setNotSeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setNotSeeded(false);
    setWallet(null);
    apiFetch<{ data: YastasWallet }>(`/yastas/wallets/${locationId}`)
      .then(body => setWallet(body.data))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotSeeded(true);
        } else {
          setError(err instanceof ApiError ? err.message : "Failed to load wallet");
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setError(null);
    setAmount("");
    load();
  }, [locationId, refreshKey]);

  const handleSeed = async () => {
    setError(null);
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < 0) {
      setError("Indica el saldo actual en Yastás (puede ser 0)");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/yastas/wallets/${locationId}/opening-balance`, {
        method: "POST",
        body: JSON.stringify({ amount: amountNum }),
      });
      setAmount("");
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo registrar el saldo inicial");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={cardClass}>
      <div>
        <h2 className="text-sm font-semibold text-(--color-ink)">Saldo Yastás (float)</h2>
        <p className="mt-1 text-xs text-(--color-ink-tertiary)">
          Balance de la cuenta Yastás de esta ubicación — se actualiza solo con operaciones IN/OUT y transferencias.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <p className="text-sm text-(--color-ink-tertiary)">Cargando…</p>
      ) : wallet ? (
        <div>
          <p className="tabular text-2xl font-semibold text-(--color-ink)">${parseFloat(wallet.balance).toFixed(2)}</p>
          <p className="mt-1 text-xs text-(--color-ink-tertiary)">
            Actualizado {new Date(wallet.updatedAt).toLocaleString()}
          </p>
        </div>
      ) : notSeeded ? (
        !isOwner(user) ? (
          <p className="text-sm text-(--color-ink-tertiary)">
            Esta ubicación aún no tiene saldo inicial Yastás — solo un OWNER puede registrarlo.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-(--color-ink-tertiary)">
              Sin saldo inicial todavía. Registra el saldo real que muestra el portal de Yastás para esta
              ubicación — se hace una sola vez.
            </p>
            <div>
              <label className={labelClass}>Saldo actual en Yastás</label>
              <input
                value={amount}
                onChange={e => setAmount(e.target.value)}
                type="number"
                min={0}
                step="0.01"
                placeholder="0.00"
                className={inputClass}
              />
            </div>
            <button onClick={handleSeed} disabled={submitting} className={buttonClass}>
              {submitting ? "Registrando…" : "Registrar saldo inicial"}
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}

/** Manual OUT-operation entry — cash handed to the client, never touches Square. */
function OutOperationCard({ locationId, onChanged }: { locationId: string; onChanged: () => void }) {
  const [faceAmount, setFaceAmount] = useState("");
  const [receiptRef, setReceiptRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    setSuccessMessage(null);
    const amountNum = parseFloat(faceAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError("Indica el monto entregado al cliente");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/yastas/operations/out`, {
        method: "POST",
        body: JSON.stringify({
          locationId,
          faceAmount: amountNum,
          yastasReceiptRef: receiptRef.trim() || undefined,
        }),
      });
      setSuccessMessage(`Retiro de $${amountNum.toFixed(2)} registrado.`);
      setFaceAmount("");
      setReceiptRef("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo registrar el retiro");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={cardClass}>
      <div>
        <h2 className="text-sm font-semibold text-(--color-ink)">Registrar retiro (OUT)</h2>
        <p className="mt-1 text-xs text-(--color-ink-tertiary)">
          Efectivo entregado al cliente — nunca se registra en Square.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}
      {successMessage && <SuccessBanner message={successMessage} />}

      <div>
        <label className={labelClass}>Monto entregado</label>
        <input
          value={faceAmount}
          onChange={e => setFaceAmount(e.target.value)}
          type="number"
          min={0}
          step="0.01"
          placeholder="0.00"
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass}>Referencia de recibo Yastás (opcional)</label>
        <input value={receiptRef} onChange={e => setReceiptRef(e.target.value)} className={inputClass} />
      </div>

      <button onClick={handleSubmit} disabled={submitting} className={buttonClass}>
        {submitting ? "Registrando…" : "Registrar retiro"}
      </button>
    </div>
  );
}

/** Instant wallet transfer between locations — OWNER/MANAGER/ACCOUNTANT only. */
function WalletTransferCard({ locationId, onChanged }: { locationId: string; onChanged: () => void }) {
  const { user } = useAuth();
  const { locations } = useLocations();
  const [toLocationId, setToLocationId] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const role = user?.currentLocation?.role;
  const allowed = role === "OWNER" || role === "MANAGER" || role === "ACCOUNTANT";
  const otherLocations = locations.filter(l => l.id !== locationId);

  const handleSubmit = async () => {
    setError(null);
    setSuccessMessage(null);
    const amountNum = parseFloat(amount);
    if (!toLocationId) {
      setError("Elige la ubicación destino");
      return;
    }
    if (isNaN(amountNum) || amountNum <= 0) {
      setError("Indica el monto a transferir");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/yastas/wallet-transfers`, {
        method: "POST",
        body: JSON.stringify({ fromLocationId: locationId, toLocationId, amount: amountNum }),
      });
      const destName = locations.find(l => l.id === toLocationId)?.name ?? toLocationId;
      setSuccessMessage(`Se transfirieron $${amountNum.toFixed(2)} a ${destName}.`);
      setAmount("");
      setToLocationId("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo transferir");
    } finally {
      setSubmitting(false);
    }
  };

  if (!allowed) {
    return (
      <div className={cardClass}>
        <h2 className="text-sm font-semibold text-(--color-ink)">Transferir saldo entre ubicaciones</h2>
        <p className="text-sm text-(--color-ink-tertiary)">
          Solo OWNER, MANAGER o ACCOUNTANT pueden transferir saldo Yastás entre ubicaciones.
        </p>
      </div>
    );
  }

  return (
    <div className={cardClass}>
      <div>
        <h2 className="text-sm font-semibold text-(--color-ink)">Transferir saldo entre ubicaciones</h2>
        <p className="mt-1 text-xs text-(--color-ink-tertiary)">Instantáneo — sin estado pendiente.</p>
      </div>

      {error && <ErrorBanner message={error} />}
      {successMessage && <SuccessBanner message={successMessage} />}

      <div>
        <label className={labelClass}>Ubicación destino</label>
        <select value={toLocationId} onChange={e => setToLocationId(e.target.value)} className={inputClass}>
          <option value="">Selecciona…</option>
          {otherLocations.map(l => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass}>Monto</label>
        <input
          value={amount}
          onChange={e => setAmount(e.target.value)}
          type="number"
          min={0}
          step="0.01"
          placeholder="0.00"
          className={inputClass}
        />
      </div>

      <button onClick={handleSubmit} disabled={submitting} className={buttonClass}>
        {submitting ? "Transfiriendo…" : "Transferir"}
      </button>
    </div>
  );
}

/** Manual entry of Yastás's own periodic commission report — nothing to do
 * with Square, there's no automated source for this number (see brief). */
function SettlementsCard({ locationId, refreshKey, onChanged }: { locationId: string; refreshKey: number; onChanged: () => void }) {
  const { user } = useAuth();
  const [settlements, setSettlements] = useState<YastasSettlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [amountEarned, setAmountEarned] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const role = user?.currentLocation?.role;
  const allowed = role === "OWNER" || role === "MANAGER" || role === "ACCOUNTANT";

  const load = () => {
    setLoading(true);
    setListError(null);
    apiFetch<{ data: YastasSettlement[] }>(`/yastas/settlements?locationId=${locationId}`)
      .then(body => setSettlements(body.data))
      .catch((err: unknown) => setListError(err instanceof ApiError ? err.message : "Failed to load settlements"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [locationId, refreshKey]);

  const handleSubmit = async () => {
    setFormError(null);
    setSuccessMessage(null);
    const amountNum = parseFloat(amountEarned);
    if (!periodStart || !periodEnd) {
      setFormError("Indica el periodo del reporte");
      return;
    }
    if (isNaN(amountNum) || amountNum < 0) {
      setFormError("Indica la comisión reportada por Yastás");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/yastas/settlements`, {
        method: "POST",
        body: JSON.stringify({
          locationId,
          periodStart,
          periodEnd,
          amountEarned: amountNum,
          notes: notes.trim() || undefined,
        }),
      });
      setSuccessMessage(`Liquidación de $${amountNum.toFixed(2)} registrada.`);
      setPeriodStart("");
      setPeriodEnd("");
      setAmountEarned("");
      setNotes("");
      load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "No se pudo registrar la liquidación");
    } finally {
      setSubmitting(false);
    }
  };

  const confirm = async (settlement: YastasSettlement) => {
    setConfirmingId(settlement.id);
    setListError(null);
    try {
      await apiFetch(`/yastas/settlements/${settlement.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "CONFIRMED", reportedAt: new Date().toISOString() }),
      });
      load();
      onChanged();
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "No se pudo confirmar la liquidación");
    } finally {
      setConfirmingId(null);
    }
  };

  return (
    <div className={cardClass}>
      <div>
        <h2 className="text-sm font-semibold text-(--color-ink)">Liquidaciones Yastás</h2>
        <p className="mt-1 text-xs text-(--color-ink-tertiary)">
          Comisión que reporta Yastás por periodo — captúrala manualmente cuando llegue el reporte; no viene de Square.
        </p>
      </div>

      {allowed ? (
        <>
          {formError && <ErrorBanner message={formError} />}
          {successMessage && <SuccessBanner message={successMessage} />}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Inicio del periodo</label>
              <input value={periodStart} onChange={e => setPeriodStart(e.target.value)} type="date" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Fin del periodo</label>
              <input value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} type="date" className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass}>Comisión reportada</label>
            <input
              value={amountEarned}
              onChange={e => setAmountEarned(e.target.value)}
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Notas (opcional)</label>
            <input value={notes} onChange={e => setNotes(e.target.value)} className={inputClass} />
          </div>

          <button onClick={handleSubmit} disabled={submitting} className={buttonClass}>
            {submitting ? "Registrando…" : "Registrar liquidación"}
          </button>
        </>
      ) : (
        <p className="text-sm text-(--color-ink-tertiary)">
          Solo OWNER, MANAGER o ACCOUNTANT pueden registrar liquidaciones Yastás.
        </p>
      )}

      {listError && <ErrorBanner message={listError} />}

      {loading ? (
        <p className="text-sm text-(--color-ink-tertiary)">Cargando…</p>
      ) : settlements.length === 0 ? (
        <p className="text-sm text-(--color-ink-tertiary)">Sin liquidaciones registradas.</p>
      ) : (
        <div className="space-y-2">
          {settlements.map(s => (
            <div
              key={s.id}
              className="flex items-center justify-between rounded-sm border border-(--color-border-standard) px-3 py-2 text-sm"
            >
              <div>
                <p className="text-(--color-ink)">
                  {new Date(s.periodStart).toLocaleDateString()} – {new Date(s.periodEnd).toLocaleDateString()}
                  <span className="ml-2 tabular font-semibold">${parseFloat(s.amountEarned).toFixed(2)}</span>
                </p>
                {s.notes && <p className="text-xs text-(--color-ink-tertiary)">{s.notes}</p>}
              </div>
              {s.status === "CONFIRMED" ? (
                <span className="rounded-full bg-(--color-success-bg) px-2 py-0.5 text-xs font-medium text-(--color-success)">
                  Confirmada
                </span>
              ) : allowed ? (
                <button
                  onClick={() => confirm(s)}
                  disabled={confirmingId === s.id}
                  className="rounded-sm border border-(--color-border-standard) px-2.5 py-1 text-xs text-(--color-ink-secondary) hover:bg-(--color-surface)"
                >
                  {confirmingId === s.id ? "Confirmando…" : "Confirmar"}
                </button>
              ) : (
                <span className="rounded-full bg-(--color-surface-inset) px-2 py-0.5 text-xs font-medium text-(--color-ink-tertiary)">
                  Provisional
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Recent IN/OUT operations for the selected location. */
function OperationsHistoryCard({ locationId, refreshKey }: { locationId: string; refreshKey: number }) {
  const [operations, setOperations] = useState<YastasOperation[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch<{ data: YastasOperation[] }>(`/yastas/operations?locationId=${locationId}`),
      apiFetch<{ data: Employee[] }>("/employees"),
    ])
      .then(([opsBody, empBody]) => {
        setOperations(opsBody.data);
        setEmployees(empBody.data);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to load operations"))
      .finally(() => setLoading(false));
  }, [locationId, refreshKey]);

  const employeeName = (id: string) => employees.find(e => e.id === id)?.name ?? id.slice(0, 8);

  const columns: Column<YastasOperation>[] = [
    {
      key: "direction",
      header: "Tipo",
      render: v => (
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            v === "IN"
              ? "bg-(--color-success-bg) text-(--color-success)"
              : "bg-(--color-warning-bg) text-(--color-warning)"
          }`}
        >
          {v as string}
        </span>
      ),
    },
    { key: "faceAmount", header: "Monto", align: "right", render: v => `$${parseFloat(v as string).toFixed(2)}` },
    { key: "employeeId", header: "Empleado", render: v => employeeName(v as string) },
    { key: "yastasReceiptRef", header: "Referencia", render: v => (v as string | null) ?? "-" },
    { key: "occurredAt", header: "Fecha", render: v => new Date(v as string).toLocaleString() },
  ];

  return (
    <div className={cardClass}>
      <h2 className="text-sm font-semibold text-(--color-ink)">Operaciones recientes</h2>
      {error && <ErrorBanner message={error} />}
      {loading ? (
        <p className="text-sm text-(--color-ink-tertiary)">Cargando…</p>
      ) : (
        <Table data={operations} columns={columns} keyExtractor={o => o.id} emptyMessage="Sin operaciones registradas." />
      )}
    </div>
  );
}

export function YastasScreen() {
  const { locations, loading: locationsLoading, error: locationsError } = useLocations();
  const [locationId, setLocationId] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!locationId && locations.length > 0) setLocationId(locations[0].id);
  }, [locations, locationId]);

  const bumpRefresh = () => setRefreshKey(k => k + 1);

  if (locationsLoading) return <p className="text-sm text-(--color-ink-tertiary)">Loading…</p>;
  if (locationsError) return <ErrorBanner message={locationsError} />;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-(--color-ink)">Yastás</h1>
        <p className="mt-1 text-sm text-(--color-ink-tertiary)">
          Ledger paralelo de operaciones bancarias Yastás — nunca toca ventas ni inventario.
        </p>
      </div>

      <div>
        <label className={labelClass}>Ubicación</label>
        <select value={locationId} onChange={e => setLocationId(e.target.value)} className={inputClass}>
          {locations.map(l => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      {locationId && (
        <>
          <WalletCard locationId={locationId} refreshKey={refreshKey} onChanged={bumpRefresh} />
          <OutOperationCard locationId={locationId} onChanged={bumpRefresh} />
          <WalletTransferCard locationId={locationId} onChanged={bumpRefresh} />
          <SettlementsCard locationId={locationId} refreshKey={refreshKey} onChanged={bumpRefresh} />
          <OperationsHistoryCard locationId={locationId} refreshKey={refreshKey} />
        </>
      )}
    </div>
  );
}
