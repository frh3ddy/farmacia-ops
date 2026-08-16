import { useLocations } from "../../lib/useLocations";

type LocationPickerProps = {
  value: string;
  onChange: (locationId: string) => void;
  /** Adds a leading "all locations" option with value "". */
  allowAll?: boolean;
  allLabel?: string;
  disabled?: boolean;
};

export function LocationPicker({
  value,
  onChange,
  allowAll = false,
  allLabel = "All locations",
  disabled,
}: LocationPickerProps) {
  const { locations, loading, error } = useLocations();

  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled || loading}
        className="w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-1.5 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        {allowAll && <option value="">{allLabel}</option>}
        {locations.map(location => (
          <option key={location.id} value={location.id}>
            {location.name}
            {!location.isActive ? " (inactive)" : ""}
          </option>
        ))}
      </select>
      {loading && <span className="text-xs text-(--color-ink-tertiary)">Loading…</span>}
      {error && <span className="text-xs text-(--color-destructive)">{error}</span>}
    </div>
  );
}
