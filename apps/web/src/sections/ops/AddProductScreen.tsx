import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";

type CategoryOption = { id: string; name: string; parentId: string | null };
type LaboratoryOption = { id: string; name: string };
type MedicationType = "GENERICO" | "DE_MARCA" | "SIMILAR";

const MEDICATION_TYPES: { value: MedicationType; label: string }[] = [
  { value: "GENERICO", label: "Genérico" },
  { value: "DE_MARCA", label: "De marca" },
  { value: "SIMILAR", label: "Similar" },
];

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";
const labelClass = "mb-2 block text-sm font-medium text-(--color-ink-secondary)";

export function AddProductScreen() {
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [laboratories, setLaboratories] = useState<LaboratoryOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [topCategoryId, setTopCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [labId, setLabId] = useState("");
  const [presentation, setPresentation] = useState("");
  const [medicationType, setMedicationType] = useState<MedicationType | "">("");
  const [activeIngredient, setActiveIngredient] = useState("");
  const [concentration, setConcentration] = useState("");
  const [requiresPrescription, setRequiresPrescription] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ categories: CategoryOption[] }>("/products/categories"),
      apiFetch<{ laboratories: LaboratoryOption[] }>("/products/laboratories"),
    ])
      .then(([categoriesBody, laboratoriesBody]) => {
        setCategories(categoriesBody.categories);
        setLaboratories(laboratoriesBody.laboratories);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to load categories"))
      .finally(() => setLoadingOptions(false));
  }, []);

  const topCategories = categories.filter(c => c.parentId === null);
  const subcategories = categories.filter(c => c.parentId === topCategoryId);
  const topCategoryName = topCategories.find(c => c.id === topCategoryId)?.name ?? "";
  const isMedicine = topCategoryName === "Medicamentos";

  const resetForm = () => {
    setName("");
    setSku("");
    setSellingPrice("");
    setCostPrice("");
    setTopCategoryId("");
    setSubcategoryId("");
    setLabId("");
    setPresentation("");
    setMedicationType("");
    setActiveIngredient("");
    setConcentration("");
    setRequiresPrescription(false);
  };

  const handleSubmit = async () => {
    setError(null);
    setSuccessMessage(null);

    if (!name.trim()) {
      setError("Product name is required");
      return;
    }
    const price = parseFloat(sellingPrice);
    if (isNaN(price) || price < 0) {
      setError("A valid selling price is required");
      return;
    }

    setSubmitting(true);
    try {
      const body = await apiFetch<{ message: string; data: { product: { name: string } } }>("/products", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          sku: sku.trim() || undefined,
          sellingPrice: price,
          costPrice: costPrice.trim() ? parseFloat(costPrice) : undefined,
          categoryId: subcategoryId || topCategoryId || undefined,
          labId: labId || undefined,
          presentation: presentation.trim() || undefined,
          medicationType: isMedicine && medicationType ? medicationType : undefined,
          activeIngredient: isMedicine ? activeIngredient.trim() || undefined : undefined,
          concentration: isMedicine ? concentration.trim() || undefined : undefined,
          requiresPrescription: isMedicine ? requiresPrescription : undefined,
          syncToSquare: false,
        }),
      });
      setSuccessMessage(`Created "${body.data.product.name}".`);
      resetForm();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create product");
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingOptions) return <p className="text-sm text-(--color-ink-tertiary)">Loading…</p>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-(--color-ink)">Add product</h1>

      {error && (
        <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="rounded-md border border-(--color-success) bg-(--color-success-bg) px-4 py-2 text-sm text-(--color-success)">
          {successMessage}
        </div>
      )}

      <div className="space-y-6">
        <div>
          <label className={labelClass}>
            Nombre comercial <span className="text-(--color-destructive)">*</span>
          </label>
          <input value={name} onChange={e => setName(e.target.value)} className={inputClass} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>SKU</label>
            <input value={sku} onChange={e => setSku(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>
              Precio de venta <span className="text-(--color-destructive)">*</span>
            </label>
            <input
              type="number"
              step="0.01"
              min={0}
              value={sellingPrice}
              onChange={e => setSellingPrice(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>Costo</label>
          <input
            type="number"
            step="0.01"
            min={0}
            value={costPrice}
            onChange={e => setCostPrice(e.target.value)}
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Categoría</label>
            <select
              value={topCategoryId}
              onChange={e => {
                setTopCategoryId(e.target.value);
                setSubcategoryId("");
              }}
              className={inputClass}
            >
              <option value="">Sin categoría</option>
              {topCategories.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Subcategoría</label>
            <select
              value={subcategoryId}
              onChange={e => setSubcategoryId(e.target.value)}
              disabled={!topCategoryId || subcategories.length === 0}
              className={`${inputClass} disabled:opacity-50`}
            >
              <option value="">{topCategoryId ? "Sin subcategoría" : "Elige una categoría primero"}</option>
              {subcategories.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Laboratorio</label>
            <select value={labId} onChange={e => setLabId(e.target.value)} className={inputClass}>
              <option value="">Sin laboratorio</option>
              {laboratories.map(l => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Presentación</label>
            <input
              value={presentation}
              onChange={e => setPresentation(e.target.value)}
              placeholder="Caja c/20 tabletas"
              className={inputClass}
            />
          </div>
        </div>

        {isMedicine && (
          <div className="space-y-6 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-tertiary)">
              Atributos de medicamento
            </p>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Tipo de medicamento</label>
                <select
                  value={medicationType}
                  onChange={e => setMedicationType(e.target.value as MedicationType | "")}
                  className={inputClass}
                >
                  <option value="">Sin especificar</option>
                  {MEDICATION_TYPES.map(t => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Concentración</label>
                <input
                  value={concentration}
                  onChange={e => setConcentration(e.target.value)}
                  placeholder="500mg"
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label className={labelClass}>Principio activo</label>
              <input value={activeIngredient} onChange={e => setActiveIngredient(e.target.value)} className={inputClass} />
            </div>

            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={requiresPrescription}
                onChange={e => setRequiresPrescription(e.target.checked)}
                className="accent-(--color-accent)"
              />
              <span className="text-sm text-(--color-ink)">Requiere receta</span>
            </label>
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full rounded-sm bg-(--color-accent) py-2.5 text-sm font-medium text-(--color-accent-contrast) hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Creando…" : "Crear producto"}
        </button>
      </div>
    </div>
  );
}
