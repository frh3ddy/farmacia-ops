import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";

type CategoryOption = { id: string; name: string; parentId: string | null };
type LaboratoryOption = { id: string; name: string };
type ActiveIngredientOption = { id: string; name: string };
type MedicationType = "GENERICO" | "DE_MARCA" | "SIMILAR";
type PharmaceuticalForm =
  | "TABLET" | "CAPSULE" | "SUSPENSION" | "SYRUP" | "CREAM" | "OINTMENT" | "GEL"
  | "INJECTION" | "DROPS" | "SPRAY" | "PATCH" | "SUPPOSITORY" | "INHALER" | "OTHER";
type AdministrationRoute =
  | "ORAL" | "TOPICAL" | "INJECTABLE" | "OPHTHALMIC" | "OTIC" | "NASAL" | "RECTAL"
  | "VAGINAL" | "INHALED" | "SUBLINGUAL" | "OTHER";

const MEDICATION_TYPES: { value: MedicationType; label: string }[] = [
  { value: "GENERICO", label: "Genérico" },
  { value: "DE_MARCA", label: "De marca" },
  { value: "SIMILAR", label: "Similar" },
];

const FORMS: { value: PharmaceuticalForm; label: string }[] = [
  { value: "TABLET", label: "Tableta" },
  { value: "CAPSULE", label: "Cápsula" },
  { value: "SUSPENSION", label: "Suspensión" },
  { value: "SYRUP", label: "Jarabe" },
  { value: "CREAM", label: "Crema" },
  { value: "OINTMENT", label: "Ungüento" },
  { value: "GEL", label: "Gel" },
  { value: "INJECTION", label: "Inyección" },
  { value: "DROPS", label: "Gotas" },
  { value: "SPRAY", label: "Spray" },
  { value: "PATCH", label: "Parche" },
  { value: "SUPPOSITORY", label: "Supositorio" },
  { value: "INHALER", label: "Inhalador" },
  { value: "OTHER", label: "Otro" },
];

const ROUTES: { value: AdministrationRoute; label: string }[] = [
  { value: "ORAL", label: "Oral" },
  { value: "TOPICAL", label: "Tópica" },
  { value: "INJECTABLE", label: "Inyectable" },
  { value: "OPHTHALMIC", label: "Oftálmica" },
  { value: "OTIC", label: "Ótica" },
  { value: "NASAL", label: "Nasal" },
  { value: "RECTAL", label: "Rectal" },
  { value: "VAGINAL", label: "Vaginal" },
  { value: "INHALED", label: "Inhalada" },
  { value: "SUBLINGUAL", label: "Sublingual" },
  { value: "OTHER", label: "Otra" },
];

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none";
const labelClass = "mb-2 block text-sm font-medium text-(--color-ink-secondary)";

export function AddProductScreen() {
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [laboratories, setLaboratories] = useState<LaboratoryOption[]>([]);
  const [activeIngredients, setActiveIngredients] = useState<ActiveIngredientOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [topCategoryId, setTopCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [labName, setLabName] = useState("");
  const [presentation, setPresentation] = useState("");
  const [medicationType, setMedicationType] = useState<MedicationType | "">("");
  const [ingredientNames, setIngredientNames] = useState<string[]>([]);
  const [ingredientInput, setIngredientInput] = useState("");
  const [strength, setStrength] = useState("");
  const [form, setForm] = useState<PharmaceuticalForm | "">("");
  const [route, setRoute] = useState<AdministrationRoute | "">("");
  const [requiresPrescription, setRequiresPrescription] = useState(false);
  const [isControlled, setIsControlled] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ categories: CategoryOption[] }>("/products/categories"),
      apiFetch<{ laboratories: LaboratoryOption[] }>("/products/laboratories"),
      apiFetch<{ activeIngredients: ActiveIngredientOption[] }>("/products/active-ingredients"),
    ])
      .then(([categoriesBody, laboratoriesBody, ingredientsBody]) => {
        setCategories(categoriesBody.categories);
        setLaboratories(laboratoriesBody.laboratories);
        setActiveIngredients(ingredientsBody.activeIngredients);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to load categories"))
      .finally(() => setLoadingOptions(false));
  }, []);

  const topCategories = categories.filter(c => c.parentId === null);
  const subcategories = categories.filter(c => c.parentId === topCategoryId);
  const topCategoryName = topCategories.find(c => c.id === topCategoryId)?.name ?? "";
  const isMedicine = topCategoryName === "Medicamentos";

  const addIngredient = () => {
    const trimmed = ingredientInput.trim();
    if (trimmed && !ingredientNames.includes(trimmed)) {
      setIngredientNames(prev => [...prev, trimmed]);
    }
    setIngredientInput("");
  };

  const resetForm = () => {
    setName("");
    setSku("");
    setSellingPrice("");
    setCostPrice("");
    setTopCategoryId("");
    setSubcategoryId("");
    setLabName("");
    setPresentation("");
    setMedicationType("");
    setIngredientNames([]);
    setIngredientInput("");
    setStrength("");
    setForm("");
    setRoute("");
    setRequiresPrescription(false);
    setIsControlled(false);
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

    const hasMedicationInfo = isMedicine && ingredientNames.length > 0 && strength.trim() && form && route;

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
          labName: labName.trim() || undefined,
          presentation: presentation.trim() || undefined,
          medicationType: isMedicine && medicationType ? medicationType : undefined,
          requiresPrescription: isMedicine ? requiresPrescription : undefined,
          isControlled: isMedicine ? isControlled : undefined,
          medication: hasMedicationInfo
            ? {
                name: `${ingredientNames.join(" + ")} ${strength.trim()} ${FORMS.find(f => f.value === form)?.label ?? ""}`.trim(),
                form,
                route,
                strength: strength.trim(),
                activeIngredientNames: ingredientNames,
              }
            : undefined,
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
            <input
              list="laboratory-suggestions"
              value={labName}
              onChange={e => setLabName(e.target.value)}
              placeholder="Escribe para buscar o crear uno nuevo"
              className={inputClass}
            />
            <datalist id="laboratory-suggestions">
              {laboratories.map(l => (
                <option key={l.id} value={l.name} />
              ))}
            </datalist>
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
              Medicamento — identifica la molécula para buscar equivalentes
            </p>

            <div>
              <label className={labelClass}>Principio(s) activo(s)</label>
              <div className="flex gap-2">
                <input
                  list="ingredient-suggestions"
                  value={ingredientInput}
                  onChange={e => setIngredientInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addIngredient();
                    }
                  }}
                  placeholder="Paracetamol"
                  className={inputClass}
                />
                <datalist id="ingredient-suggestions">
                  {activeIngredients.map(i => (
                    <option key={i.id} value={i.name} />
                  ))}
                </datalist>
                <button
                  type="button"
                  onClick={addIngredient}
                  className="shrink-0 rounded-sm border border-(--color-border-standard) px-3 py-2 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
                >
                  Agregar
                </button>
              </div>
              {ingredientNames.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {ingredientNames.map(n => (
                    <span
                      key={n}
                      className="flex items-center gap-1 rounded-full bg-(--color-accent)/10 px-2.5 py-0.5 text-xs font-medium text-(--color-accent)"
                    >
                      {n}
                      <button
                        type="button"
                        onClick={() => setIngredientNames(prev => prev.filter(x => x !== n))}
                        aria-label={`Quitar ${n}`}
                        className="text-(--color-accent)/70 hover:text-(--color-accent)"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>Concentración</label>
                <input
                  value={strength}
                  onChange={e => setStrength(e.target.value)}
                  placeholder="500 mg"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Forma</label>
                <select value={form} onChange={e => setForm(e.target.value as PharmaceuticalForm | "")} className={inputClass}>
                  <option value="">Sin especificar</option>
                  {FORMS.map(f => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Vía</label>
                <select value={route} onChange={e => setRoute(e.target.value as AdministrationRoute | "")} className={inputClass}>
                  <option value="">Sin especificar</option>
                  {ROUTES.map(r => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

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

            <div className="flex gap-6">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={requiresPrescription}
                  onChange={e => setRequiresPrescription(e.target.checked)}
                  className="accent-(--color-accent)"
                />
                <span className="text-sm text-(--color-ink)">Requiere receta</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={isControlled}
                  onChange={e => setIsControlled(e.target.checked)}
                  className="accent-(--color-accent)"
                />
                <span className="text-sm text-(--color-ink)">Sustancia controlada</span>
              </label>
            </div>
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
