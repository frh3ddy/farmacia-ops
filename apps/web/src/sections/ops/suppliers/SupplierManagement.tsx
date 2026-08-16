import { useState } from "react";
import { Table, type Column } from "../../../components/ui/Table";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { apiFetch, ApiError } from "../../../lib/apiFetch";
import { useSuppliers } from "../../../lib/ops/useSuppliers";
import type { Supplier } from "../../../lib/ops/types";

type FormState = { name: string; initials: string[]; contactInfo: string; isActive: boolean };
const emptyForm: FormState = { name: "", initials: [], contactInfo: "", isActive: true };

export function SupplierManagement() {
  const { suppliers, loading, error: fetchError, refetch } = useSuppliers();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [newInitial, setNewInitial] = useState("");
  const [filterActive, setFilterActive] = useState(true);
  const [deactivating, setDeactivating] = useState<Supplier | null>(null);

  const startEdit = (supplier: Supplier) => {
    setEditingId(supplier.id);
    setForm({
      name: supplier.name,
      initials: supplier.initials,
      contactInfo: supplier.contactInfo ?? "",
      isActive: supplier.isActive,
    });
    setNewInitial("");
    setShowAddForm(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setShowAddForm(false);
    setForm(emptyForm);
    setNewInitial("");
  };

  const addInitial = () => {
    const trimmed = newInitial.trim();
    if (trimmed && !form.initials.includes(trimmed)) {
      setForm({ ...form, initials: [...form.initials, trimmed] });
      setNewInitial("");
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError("Supplier name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await apiFetch(`/admin/inventory/cutover/suppliers/${editingId}/update`, {
          method: "POST",
          body: JSON.stringify({
            name: form.name.trim(),
            initials: form.initials,
            contactInfo: form.contactInfo.trim() || null,
            isActive: form.isActive,
          }),
        });
      } else {
        await apiFetch("/admin/inventory/cutover/suppliers", {
          method: "POST",
          body: JSON.stringify({
            name: form.name.trim(),
            initials: form.initials,
            contactInfo: form.contactInfo.trim() || null,
          }),
        });
      }
      await refetch();
      cancelEdit();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save supplier");
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async () => {
    if (!deactivating) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/admin/inventory/cutover/suppliers/${deactivating.id}/delete`, { method: "POST" });
      await refetch();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to deactivate supplier");
    } finally {
      setDeactivating(null);
      setSaving(false);
    }
  };

  const filtered = filterActive ? suppliers.filter(s => s.isActive) : suppliers;

  const columns: Column<Supplier>[] = [
    { key: "name", header: "Name" },
    {
      key: "initials",
      header: "Initials",
      render: v =>
        (v as string[]).length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {(v as string[]).map((init, i) => (
              <span key={i} className="rounded-full bg-(--color-accent)/10 px-2 py-0.5 text-xs font-medium text-(--color-accent)">
                {init}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-(--color-ink-muted)">—</span>
        ),
    },
    { key: "contactInfo", header: "Contact info", render: v => (v as string | null) ?? "—" },
    {
      key: "isActive",
      header: "Status",
      render: v => (
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            v ? "bg-(--color-success-bg) text-(--color-success)" : "bg-(--color-surface-inset) text-(--color-ink-tertiary)"
          }`}
        >
          {v ? "Active" : "Inactive"}
        </span>
      ),
    },
    {
      key: "id",
      header: "Actions",
      render: (_v, supplier) => (
        <div className="flex gap-3">
          <button
            onClick={() => startEdit(supplier)}
            disabled={saving || editingId !== null || showAddForm}
            className="text-(--color-accent) hover:text-(--color-accent-hover) disabled:opacity-50"
          >
            Edit
          </button>
          {supplier.isActive && (
            <button
              onClick={() => setDeactivating(supplier)}
              disabled={saving || editingId !== null}
              className="text-(--color-destructive) hover:opacity-80 disabled:opacity-50"
            >
              Deactivate
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-(--color-ink)">Supplier management</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setFilterActive(!filterActive)}
            className="rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface-raised)"
          >
            {filterActive ? "Show all" : "Show active only"}
          </button>
          <button
            onClick={() => {
              cancelEdit();
              setShowAddForm(true);
            }}
            disabled={saving || editingId !== null}
            className="rounded-sm bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:opacity-50"
          >
            + Add supplier
          </button>
        </div>
      </div>

      {(error || fetchError) && (
        <div className="mb-4 rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error ?? fetchError}
        </div>
      )}

      {(showAddForm || editingId) && (
        <div className="mb-6 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
          <h3 className="mb-3 font-semibold text-(--color-ink)">{editingId ? "Edit supplier" : "Add supplier"}</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-(--color-ink-secondary)">Supplier name *</label>
              <input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="e.g., Levi Pharmaceuticals"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-(--color-ink-secondary)">Initials/abbreviations</label>
              <div className="mb-2 flex gap-2">
                <input
                  value={newInitial}
                  onChange={e => setNewInitial(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addInitial();
                    }
                  }}
                  placeholder="e.g., L, Lev, Levi"
                  maxLength={20}
                  className={`flex-1 ${inputClass}`}
                />
                <button
                  type="button"
                  onClick={addInitial}
                  className="rounded-sm bg-(--color-accent) px-3 py-2 text-sm text-(--color-accent-contrast) hover:bg-(--color-accent-hover)"
                >
                  Add
                </button>
              </div>
              {form.initials.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {form.initials.map((initial, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 rounded-full bg-(--color-accent)/10 px-3 py-1 text-sm font-medium text-(--color-accent)"
                    >
                      {initial}
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, initials: form.initials.filter((_, i) => i !== idx) })}
                        aria-label={`Remove ${initial}`}
                        className="ml-1 hover:opacity-70"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-1 text-xs text-(--color-ink-tertiary)">Used for cost extraction matching during cutover.</p>
            </div>
            <div className="md:col-span-2">
              <label className="mb-1 block text-sm font-medium text-(--color-ink-secondary)">Contact info</label>
              <input
                value={form.contactInfo}
                onChange={e => setForm({ ...form, contactInfo: e.target.value })}
                placeholder="Email, phone, or address"
                className={inputClass}
              />
            </div>
            {editingId && (
              <label className="flex items-center gap-2 text-sm text-(--color-ink-secondary)">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={e => setForm({ ...form, isActive: e.target.checked })}
                />
                Active
              </label>
            )}
          </div>
          <div className="mt-4 flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving || !form.name.trim()}
              className="rounded-sm bg-(--color-accent) px-4 py-2 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:opacity-50"
            >
              {saving ? "Saving…" : editingId ? "Update" : "Create"}
            </button>
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="rounded-sm border border-(--color-border-standard) px-4 py-2 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface-raised) disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading && suppliers.length === 0 ? (
        <p className="py-8 text-center text-sm text-(--color-ink-tertiary)">Loading suppliers…</p>
      ) : (
        <Table
          data={filtered}
          columns={columns}
          keyExtractor={s => s.id}
          emptyMessage={filterActive ? "No active suppliers found." : "No suppliers found."}
        />
      )}

      <p className="mt-3 text-sm text-(--color-ink-tertiary)">
        Showing {filtered.length} of {suppliers.length} supplier(s)
      </p>

      <ConfirmDialog
        open={deactivating !== null}
        title="Deactivate supplier"
        description={`This hides "${deactivating?.name}" from active pickers. It can be reactivated later by editing it.`}
        confirmPhrase={deactivating?.name ?? ""}
        confirmLabel="Deactivate"
        destructive
        onConfirm={handleDeactivate}
        onCancel={() => setDeactivating(null)}
      />
    </div>
  );
}

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";
