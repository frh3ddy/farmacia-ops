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
type Empaque =
  | "FRASCO" | "FRASCO_AMPULA" | "TUBO" | "BLISTER" | "SOBRE" | "AMPOLLETA"
  | "GOTERO" | "AEROSOL" | "PARCHE" | "CAJA";
type IngredientEntry = { name: string; valor: string; unidad: string };

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

const EMPAQUES: { value: Empaque; label: string }[] = [
  { value: "FRASCO", label: "Frasco" },
  { value: "FRASCO_AMPULA", label: "Frasco ámpula" },
  { value: "TUBO", label: "Tubo" },
  { value: "BLISTER", label: "Blíster" },
  { value: "SOBRE", label: "Sobre" },
  { value: "AMPOLLETA", label: "Ampolleta" },
  { value: "GOTERO", label: "Gotero" },
  { value: "AEROSOL", label: "Aerosol" },
  { value: "PARCHE", label: "Parche" },
  { value: "CAJA", label: "Caja" },
];

const CONCENTRACION_UNIDADES = ["mg", "mg/ml", "%", "mcg", "UI"];

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
  const [ingredients, setIngredients] = useState<IngredientEntry[]>([]);
  const [ingredientInput, setIngredientInput] = useState("");
  const [ingredientValorInput, setIngredientValorInput] = useState("");
  const [ingredientUnidadInput, setIngredientUnidadInput] = useState("");
  const [strength, setStrength] = useState("");
  const [form, setForm] = useState<PharmaceuticalForm | "">("");
  const [route, setRoute] = useState<AdministrationRoute | "">("");
  const [requiresPrescription, setRequiresPrescription] = useState(false);
  const [isControlled, setIsControlled] = useState(false);
  const [empaquePrimario, setEmpaquePrimario] = useState<Empaque | "">("");
  const [empaqueSecundario, setEmpaqueSecundario] = useState<Empaque | "">("");
  const [cantidad, setCantidad] = useState("");

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
    if (trimmed && !ingredients.some(i => i.name === trimmed)) {
      setIngredients(prev => [...prev, { name: trimmed, valor: ingredientValorInput.trim(), unidad: ingredientUnidadInput }]);
    }
    setIngredientInput("");
    setIngredientValorInput("");
    setIngredientUnidadInput("");
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
    setIngredients([]);
    setIngredientInput("");
    setIngredientValorInput("");
    setIngredientUnidadInput("");
    setStrength("");
    setForm("");
    setRoute("");
    setRequiresPrescription(false);
    setIsControlled(false);
    setEmpaquePrimario("");
    setEmpaqueSecundario("");
    setCantidad("");
  };

  const handleSubmit = async () => {
    setError(null);
    setSuccessMessage(null);

    const hasMedicationInfo = isMedicine && ingredients.length > 0 && strength.trim() && form && route;

    // For medicamento products the name can be derived from the ingredients —
    // only require a typed name when there isn't enough medication info yet.
    if (!hasMedicationInfo && !name.trim()) {
      setError("Product name is required");
      return;
    }
    const price = parseFloat(sellingPrice);
    if (isNaN(price) || price < 0) {
      setError("A valid selling price is required");
      return;
    }

    const medicationDisplayName = `${ingredients.map(i => i.name).join(" + ")} ${strength.trim()} ${FORMS.find(f => f.value === form)?.label ?? ""}`.trim();

    setSubmitting(true);
    try {
      const body = await apiFetch<{ message: string; data: { product: { name: string } } }>("/products", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || (hasMedicationInfo ? medicationDisplayName : ""),
          nombreManual: isMedicine && name.trim() ? name.trim() : undefined,
          sku: sku.trim() || undefined,
          sellingPrice: price,
          costPrice: costPrice.trim() ? parseFloat(costPrice) : undefined,
          categoryId: subcategoryId || topCategoryId || undefined,
          labName: labName.trim() || undefined,
          presentation: !isMedicine ? presentation.trim() || undefined : undefined,
          presentacionManual: isMedicine && presentation.trim() ? presentation.trim() : undefined,
          medicationType: isMedicine && medicationType ? medicationType : undefined,
          requiresPrescription: isMedicine ? requiresPrescription : undefined,
          isControlled: isMedicine ? isControlled : undefined,
          empaquePrimario: isMedicine && empaquePrimario ? empaquePrimario : undefined,
          empaqueSecundario: isMedicine && empaqueSecundario ? empaqueSecundario : undefined,
          cantidad: isMedicine && cantidad.trim() ? parseInt(cantidad, 10) : undefined,
          medication: hasMedicationInfo
            ? {
                name: medicationDisplayName,
                form,
                route,
                strength: strength.trim(),
                activeIngredients: ingredients.map(i => ({
                  name: i.name,
                  concentracionValor: i.valor.trim() ? parseFloat(i.valor) : undefined,
                  concentracionUnidad: i.unidad || undefined,
                })),
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
            Nombre comercial {!isMedicine && <span className="text-(--color-destructive)">*</span>}
          </label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={isMedicine ? "Se genera automáticamente si se deja vacío" : undefined}
            className={inputClass}
          />
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
              placeholder={isMedicine ? "Se genera automáticamente si se deja vacío" : "Caja c/20 tabletas"}
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
                  className={`${inputClass} flex-1`}
                />
                <input
                  value={ingredientValorInput}
                  onChange={e => setIngredientValorInput(e.target.value)}
                  placeholder="500"
                  type="number"
                  className={`${inputClass} w-20`}
                />
                <select
                  value={ingredientUnidadInput}
                  onChange={e => setIngredientUnidadInput(e.target.value)}
                  className={`${inputClass} w-24`}
                >
                  <option value="">–</option>
                  {CONCENTRACION_UNIDADES.map(u => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
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
              {ingredients.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {ingredients.map(i => (
                    <span
                      key={i.name}
                      className="flex items-center gap-1 rounded-full bg-(--color-accent)/10 px-2.5 py-0.5 text-xs font-medium text-(--color-accent)"
                    >
                      {i.name}
                      {i.valor && ` ${i.valor}${i.unidad}`}
                      <button
                        type="button"
                        onClick={() => setIngredients(prev => prev.filter(x => x.name !== i.name))}
                        aria-label={`Quitar ${i.name}`}
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

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>Empaque primario</label>
                <select
                  value={empaquePrimario}
                  onChange={e => setEmpaquePrimario(e.target.value as Empaque | "")}
                  className={inputClass}
                >
                  <option value="">Sin especificar</option>
                  {EMPAQUES.map(e => (
                    <option key={e.value} value={e.value}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Empaque secundario</label>
                <select
                  value={empaqueSecundario}
                  onChange={e => setEmpaqueSecundario(e.target.value as Empaque | "")}
                  className={inputClass}
                >
                  <option value="">Sin empaque exterior</option>
                  {EMPAQUES.map(e => (
                    <option key={e.value} value={e.value}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Cantidad</label>
                <input
                  value={cantidad}
                  onChange={e => setCantidad(e.target.value)}
                  type="number"
                  min={0}
                  placeholder="20"
                  className={inputClass}
                />
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
