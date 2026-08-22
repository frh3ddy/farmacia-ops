export type CategoryOption = { id: string; name: string; parentId: string | null };

type CategoryPickerProps = {
  categories: CategoryOption[];
  topCategoryId: string;
  subcategoryId: string;
  onTopCategoryChange: (id: string) => void;
  onSubcategoryChange: (id: string) => void;
  className?: string;
};

const inputClass =
  "w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-2 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none disabled:opacity-50";
const labelClass = "mb-2 block text-sm font-medium text-(--color-ink-secondary)";

/** Top-category / subcategory cascade, selecting a top category resets the subcategory. */
export function CategoryPicker({
  categories,
  topCategoryId,
  subcategoryId,
  onTopCategoryChange,
  onSubcategoryChange,
  className,
}: CategoryPickerProps) {
  const topCategories = categories.filter(c => c.parentId === null);
  const subcategories = categories.filter(c => c.parentId === topCategoryId);

  return (
    <div className={`grid grid-cols-2 gap-4 ${className ?? ""}`}>
      <div>
        <label className={labelClass}>Categoría</label>
        <select
          value={topCategoryId}
          onChange={e => {
            onTopCategoryChange(e.target.value);
            onSubcategoryChange("");
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
          onChange={e => onSubcategoryChange(e.target.value)}
          disabled={!topCategoryId || subcategories.length === 0}
          className={inputClass}
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
  );
}
