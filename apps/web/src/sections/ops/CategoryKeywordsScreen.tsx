import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/apiFetch";
import { CategoryPicker, type CategoryOption } from "./components/CategoryPicker";

type CategoryWithKeywords = CategoryOption & { symptomKeywords: string[] };

export function CategoryKeywordsScreen() {
  const [categories, setCategories] = useState<CategoryWithKeywords[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [topCategoryId, setTopCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");

  useEffect(() => {
    apiFetch<{ categories: CategoryWithKeywords[] }>("/products/categories")
      .then(body => setCategories(body.categories))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Failed to load categories"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-(--color-ink-tertiary)">Loading…</p>;

  const selected = categories.find(c => c.id === (subcategoryId || topCategoryId)) ?? null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-(--color-ink)">Symptom keywords</h1>
        <p className="mt-1 text-sm text-(--color-ink-tertiary)">
          Palabras que un empleado podría escribir en la búsqueda (ej. "fiebre", "gripa") mapeadas a la categoría
          que las resuelve.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-(--color-destructive) bg-(--color-destructive-bg) px-4 py-2 text-sm text-(--color-destructive)">
          {error}
        </div>
      )}

      <CategoryPicker
        categories={categories}
        topCategoryId={topCategoryId}
        subcategoryId={subcategoryId}
        onTopCategoryChange={setTopCategoryId}
        onSubcategoryChange={setSubcategoryId}
      />

      {selected && (
        <KeywordsPanel
          key={selected.id}
          category={selected}
          onSaved={next => setCategories(prev => prev.map(c => (c.id === selected.id ? { ...c, symptomKeywords: next } : c)))}
        />
      )}
    </div>
  );
}

function KeywordsPanel({
  category,
  onSaved,
}: {
  category: CategoryWithKeywords;
  onSaved: (symptomKeywords: string[]) => void;
}) {
  const [keywords, setKeywords] = useState(category.symptomKeywords);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string[]) => {
    setSaving(true);
    setError(null);
    try {
      const body = await apiFetch<{ data: { category: { symptomKeywords: string[] } } }>(
        `/products/categories/${category.id}/symptom-keywords`,
        { method: "PATCH", body: JSON.stringify({ symptomKeywords: next }) },
      );
      setKeywords(body.data.category.symptomKeywords);
      onSaved(body.data.category.symptomKeywords);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update keywords");
    } finally {
      setSaving(false);
    }
  };

  const addKeyword = () => {
    const trimmed = input.trim();
    if (trimmed) save([...keywords, trimmed]);
    setInput("");
  };

  const removeKeyword = (kw: string) => save(keywords.filter(k => k !== kw));

  return (
    <div className="space-y-2 rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-tertiary)">{category.name}</h4>
      {error && <p className="text-xs text-(--color-destructive)">{error}</p>}
      <div className="flex flex-wrap gap-1.5">
        {keywords.length === 0 && <span className="text-xs text-(--color-ink-tertiary)">Sin palabras registradas</span>}
        {keywords.map(kw => (
          <span
            key={kw}
            className="flex items-center gap-1 rounded-full bg-(--color-accent)/10 px-2.5 py-0.5 text-xs font-medium text-(--color-accent)"
          >
            {kw}
            <button
              type="button"
              onClick={() => removeKeyword(kw)}
              disabled={saving}
              aria-label={`Quitar ${kw}`}
              className="text-(--color-accent)/70 hover:text-(--color-accent)"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              addKeyword();
            }
          }}
          placeholder="fiebre"
          disabled={saving}
          className="flex-1 rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-1.5 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
        />
        <button
          type="button"
          onClick={addKeyword}
          disabled={saving || !input.trim()}
          className="shrink-0 rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface) disabled:opacity-50"
        >
          Agregar
        </button>
      </div>
    </div>
  );
}
