import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import { CategoryPicker, type CategoryOption } from "./components/CategoryPicker";

type LaboratoryOption = { id: string; name: string };
type ActiveIngredientOption = { id: string; name: string };
type MedicationType = "GENERIC" | "BRAND" | "SIMILAR";
type PharmaceuticalForm =
  | "TABLET" | "CAPSULE" | "SUSPENSION" | "SYRUP" | "CREAM" | "OINTMENT" | "GEL"
  | "INJECTION" | "DROPS" | "SPRAY" | "PATCH" | "SUPPOSITORY" | "INHALER" | "SOLUTION" | "OTHER";
type AdministrationRoute =
  | "ORAL" | "TOPICAL" | "INJECTABLE" | "OPHTHALMIC" | "OTIC" | "NASAL" | "RECTAL"
  | "VAGINAL" | "INHALED" | "SUBLINGUAL" | "OTHER";
type PackagingType =
  | "BOTTLE" | "VIAL" | "TUBE" | "BLISTER" | "SACHET" | "AMPOULE"
  | "DROPPER_BOTTLE" | "AEROSOL" | "PATCH" | "BOX";
type IngredientEntry = { name: string; value: string; unit: string };
type BrandSuggestion = { brand: string; category: string; ingredients: string[] };
type IngredientSuggestion = { ingredient: string; brands: string[] };

const MEDICATION_TYPES: { value: MedicationType; label: string }[] = [
  { value: "GENERIC", label: "Genérico" },
  { value: "BRAND", label: "De marca" },
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
  { value: "SOLUTION", label: "Solución" },
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

const PACKAGING_OPTIONS: { value: PackagingType; label: string }[] = [
  { value: "BOTTLE", label: "Frasco" },
  { value: "VIAL", label: "Frasco ámpula" },
  { value: "TUBE", label: "Tubo" },
  { value: "BLISTER", label: "Blíster" },
  { value: "SACHET", label: "Sobre" },
  { value: "AMPOULE", label: "Ampolleta" },
  { value: "DROPPER_BOTTLE", label: "Gotero" },
  { value: "AEROSOL", label: "Aerosol" },
  { value: "PATCH", label: "Parche" },
  { value: "BOX", label: "Caja" },
];

const CONCENTRATION_UNITS = ["mg", "mg/ml", "%", "mcg", "UI"];

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
  const [ingredientValueInput, setIngredientValueInput] = useState("");
  const [ingredientUnitInput, setIngredientUnitInput] = useState("");
  const [strength, setStrength] = useState("");
  const [form, setForm] = useState<PharmaceuticalForm | "">("");
  const [route, setRoute] = useState<AdministrationRoute | "">("");
  const [requiresPrescription, setRequiresPrescription] = useState(false);
  const [isControlled, setIsControlled] = useState(false);
  const [primaryPackaging, setPrimaryPackaging] = useState<PackagingType | "">("");
  const [secondaryPackaging, setSecondaryPackaging] = useState<PackagingType | "">("");
  const [quantity, setQuantity] = useState("");
  const [primaryContent, setPrimaryContent] = useState("");
  const [searchAliases, setSearchAliases] = useState("");
  const [brandSuggestions, setBrandSuggestions] = useState<BrandSuggestion[]>([]);
  const [ingredientSuggestions, setIngredientSuggestions] = useState<IngredientSuggestion[]>([]);

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

  // Suggestions from the static Mexican-pharmacy reference dataset (brand
  // names <-> active ingredients <-> category) — helps fill the form when the
  // employee only knows the commercial name, not the generic/category.
  useEffect(() => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setBrandSuggestions([]);
      return;
    }
    const handle = setTimeout(() => {
      apiFetch<{ brandMatches: BrandSuggestion[] }>(`/products/reference-suggestions?brandName=${encodeURIComponent(trimmed)}`)
        .then(body => setBrandSuggestions(body.brandMatches))
        .catch(() => setBrandSuggestions([]));
    }, 300);
    return () => clearTimeout(handle);
  }, [name]);

  useEffect(() => {
    const trimmed = ingredientInput.trim();
    if (trimmed.length < 2) {
      setIngredientSuggestions([]);
      return;
    }
    const handle = setTimeout(() => {
      apiFetch<{ ingredientMatches: IngredientSuggestion[] }>(`/products/reference-suggestions?ingredient=${encodeURIComponent(trimmed)}`)
        .then(body => setIngredientSuggestions(body.ingredientMatches))
        .catch(() => setIngredientSuggestions([]));
    }, 300);
    return () => clearTimeout(handle);
  }, [ingredientInput]);

  const topCategoryName = categories.find(c => c.id === topCategoryId && c.parentId === null)?.name ?? "";
  const isMedicine = topCategoryName === "Medicamentos";

  const applyBrandSuggestion = (s: BrandSuggestion) => {
    const subcategory = categories.find(c => c.name === s.category && c.parentId !== null);
    if (subcategory) {
      setTopCategoryId(subcategory.parentId!);
      setSubcategoryId(subcategory.id);
    }
    setMedicationType("BRAND");
    setBrandSuggestions([]);
  };

  const addSuggestedIngredient = (ingredientName: string) => {
    if (!ingredients.some(i => i.name === ingredientName)) {
      setIngredients(prev => [...prev, { name: ingredientName, value: "", unit: "" }]);
    }
  };

  const addSuggestedAliasBrand = (brand: string) => {
    const current = searchAliases.split(",").map(t => t.trim()).filter(Boolean);
    if (!current.includes(brand)) setSearchAliases([...current, brand].join(", "));
  };

  const addIngredient = () => {
    const trimmed = ingredientInput.trim();
    if (trimmed && !ingredients.some(i => i.name === trimmed)) {
      setIngredients(prev => [...prev, { name: trimmed, value: ingredientValueInput.trim(), unit: ingredientUnitInput }]);
    }
    setIngredientInput("");
    setIngredientValueInput("");
    setIngredientUnitInput("");
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
    setIngredientValueInput("");
    setIngredientUnitInput("");
    setStrength("");
    setForm("");
    setRoute("");
    setRequiresPrescription(false);
    setIsControlled(false);
    setPrimaryPackaging("");
    setSecondaryPackaging("");
    setQuantity("");
    setPrimaryContent("");
    setSearchAliases("");
  };

  const handleSubmit = async () => {
    setError(null);
    setSuccessMessage(null);

    // deriveName/derivePresentation (backend) build concentración straight
    // from each ingredient's own value/unit — the separate "Concentración"
    // field isn't used by either formula, it only exists to satisfy the DB's
    // required MedicationDefinition.strength column. So compose it from the
    // ingredients instead of forcing a redundant manual entry.
    const composedStrength = ingredients
      .filter(i => i.value.trim())
      .map(i => `${i.value.trim()}${i.unit}`)
      .join("/");
    const resolvedStrength = strength.trim() || composedStrength;

    const hasMedicationInfo = isMedicine && ingredients.length > 0 && form && route;

    // For medicamento products the name can be derived from the ingredients —
    // only require a typed name when there isn't enough medication info yet.
    if (!hasMedicationInfo && !name.trim()) {
      setError(
        isMedicine
          ? "Escribe un nombre, o completa principio activo, forma y vía para generarlo automáticamente."
          : "Product name is required",
      );
      return;
    }
    const price = parseFloat(sellingPrice);
    if (isNaN(price) || price < 0) {
      setError("A valid selling price is required");
      return;
    }

    const medicationDisplayName = `${ingredients.map(i => i.name).join(" + ")} ${resolvedStrength} ${FORMS.find(f => f.value === form)?.label ?? ""}`.trim();

    setSubmitting(true);
    try {
      const body = await apiFetch<{ message: string; data: { product: { name: string } } }>("/products", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || (hasMedicationInfo ? medicationDisplayName : ""),
          manualName: isMedicine && name.trim() ? name.trim() : undefined,
          sku: sku.trim() || undefined,
          sellingPrice: price,
          costPrice: costPrice.trim() ? parseFloat(costPrice) : undefined,
          categoryId: subcategoryId || topCategoryId || undefined,
          labName: labName.trim() || undefined,
          presentation: !isMedicine ? presentation.trim() || undefined : undefined,
          manualPresentation: isMedicine && presentation.trim() ? presentation.trim() : undefined,
          medicationType: isMedicine && medicationType ? medicationType : undefined,
          requiresPrescription: isMedicine ? requiresPrescription : undefined,
          isControlled: isMedicine ? isControlled : undefined,
          primaryPackaging: isMedicine && primaryPackaging ? primaryPackaging : undefined,
          secondaryPackaging: isMedicine && secondaryPackaging ? secondaryPackaging : undefined,
          quantity: isMedicine && quantity.trim() ? parseInt(quantity, 10) : undefined,
          primaryContent:
            isMedicine && primaryContent.trim() ? parseInt(primaryContent, 10) : undefined,
          searchAliases:
            isMedicine && searchAliases.trim()
              ? searchAliases.split(",").map(t => t.trim()).filter(Boolean)
              : undefined,
          medication: hasMedicationInfo
            ? {
                name: medicationDisplayName,
                form,
                route,
                strength: resolvedStrength,
                activeIngredients: ingredients.map(i => ({
                  name: i.name,
                  concentrationValue: i.value.trim() ? parseFloat(i.value) : undefined,
                  concentrationUnit: i.unit || undefined,
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
          {brandSuggestions.length > 0 && (
            <div className="mt-1.5 space-y-1.5">
              {brandSuggestions.map((s, i) => (
                <div key={i} className="rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-2.5 py-1.5">
                  <button
                    type="button"
                    onClick={() => applyBrandSuggestion(s)}
                    className="text-left text-xs text-(--color-ink-secondary) hover:text-(--color-ink)"
                  >
                    <span className="font-medium text-(--color-ink)">{s.brand}</span> — usar categoría "{s.category}"
                  </button>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.ingredients.map(ing => (
                      <button
                        key={ing}
                        type="button"
                        onClick={() => addSuggestedIngredient(ing)}
                        className="rounded-full bg-(--color-accent)/10 px-2 py-0.5 text-xs text-(--color-accent) hover:bg-(--color-accent)/20"
                      >
                        + {ing}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
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

        <CategoryPicker
          categories={categories}
          topCategoryId={topCategoryId}
          subcategoryId={subcategoryId}
          onTopCategoryChange={setTopCategoryId}
          onSubcategoryChange={setSubcategoryId}
        />

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
                  className={`${inputClass}`}
                />
                <input
                  value={ingredientValueInput}
                  onChange={e => setIngredientValueInput(e.target.value)}
                  placeholder="500"
                  type="number"
                  className={`${inputClass}`}
                />
                <select
                  value={ingredientUnitInput}
                  onChange={e => setIngredientUnitInput(e.target.value)}
                  className={`${inputClass}`}
                >
                  <option value="">–</option>
                  {CONCENTRATION_UNITS.map(u => (
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
                      {i.value && ` ${i.value}${i.unit}`}
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
                  placeholder="Se genera de los principios activos si se deja vacío"
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

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Empaque primario</label>
                <select
                  value={primaryPackaging}
                  onChange={e => setPrimaryPackaging(e.target.value as PackagingType | "")}
                  className={inputClass}
                >
                  <option value="">Sin especificar</option>
                  {PACKAGING_OPTIONS.map(e => (
                    <option key={e.value} value={e.value}>
                      {e.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-(--color-ink-tertiary)">
                  Lo que toca el producto directamente (ej. frasco, tubo, blíster) — nunca una caja.
                </p>
              </div>
              <div>
                <label className={labelClass}>Contenido del envase primario</label>
                <input
                  value={primaryContent}
                  onChange={e => setPrimaryContent(e.target.value)}
                  type="number"
                  min={0}
                  placeholder="10"
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-(--color-ink-tertiary)">
                  Ej. ml en un frasco o g en un tubo — solo aplica si hay empaque secundario y la forma no es sólida.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Empaque secundario</label>
                <select
                  value={secondaryPackaging}
                  onChange={e => setSecondaryPackaging(e.target.value as PackagingType | "")}
                  className={inputClass}
                >
                  <option value="">Sin empaque exterior</option>
                  {PACKAGING_OPTIONS.map(e => (
                    <option key={e.value} value={e.value}>
                      {e.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-(--color-ink-tertiary)">
                  El empaque exterior que lo contiene, si aplica (ej. una caja que envuelve el frasco).
                </p>
              </div>
              <div>
                <label className={labelClass}>Cantidad</label>
                <input
                  value={quantity}
                  onChange={e => setQuantity(e.target.value)}
                  type="number"
                  min={0}
                  placeholder="20"
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-(--color-ink-tertiary)">
                  Sólidos: total de piezas en el empaque secundario. Líquidos/semisólidos con ambos empaques:
                  envases primarios por empaque secundario (ej. frascos por caja).
                </p>
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

            <div>
              <label className={labelClass}>Marcas conocidas</label>
              <input
                value={searchAliases}
                onChange={e => setSearchAliases(e.target.value)}
                placeholder="Tylenol, Panadol"
                className={inputClass}
              />
              <p className="mt-1 text-xs text-(--color-ink-tertiary)">
                Separadas por comas. Para que este genérico aparezca al buscar una marca aunque no exista un
                producto de esa marca.
              </p>
              {ingredientSuggestions.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {[...new Set(ingredientSuggestions.flatMap(s => s.brands))].map(brand => (
                    <button
                      key={brand}
                      type="button"
                      onClick={() => addSuggestedAliasBrand(brand)}
                      className="rounded-full bg-(--color-accent)/10 px-2 py-0.5 text-xs text-(--color-accent) hover:bg-(--color-accent)/20"
                    >
                      + {brand}
                    </button>
                  ))}
                </div>
              )}
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
