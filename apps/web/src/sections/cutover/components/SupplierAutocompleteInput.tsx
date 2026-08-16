import { useRef, useState } from "react";
import { suggestSuppliersRemote } from "../../../lib/cutover/supplierMatching";
import type { SupplierSuggestion } from "../../../lib/cutover/types";

type SupplierAutocompleteInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSelectSuggestion: (suggestion: SupplierSuggestion) => void;
  getLocalSuggestions: (input: string) => SupplierSuggestion[];
  placeholder?: string;
  highlighted?: boolean;
  matchedByInitialLabel?: string | null;
};

/**
 * The legacy wizard repeated this exact input+dropdown (local suggestions,
 * falling back to a remote /suppliers/suggest fetch, with a 200ms-delayed
 * onBlur close guarded by a ref so a dropdown click doesn't get eaten by
 * the blur) in four separate places — every extracted-entry table row, the
 * manual-input fallback, and both the approved/skipped item editors. One
 * component now owns its own suggestion state instead of each caller
 * threading a keyed map of open/suggestions through props.
 */
export function SupplierAutocompleteInput({
  value,
  onChange,
  onSelectSuggestion,
  getLocalSuggestions,
  placeholder = "Enter supplier name",
  highlighted = false,
  matchedByInitialLabel,
}: SupplierAutocompleteInputProps) {
  const [suggestions, setSuggestions] = useState<SupplierSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const selectingRef = useRef(false);

  const handleChange = (newValue: string) => {
    onChange(newValue);
    const local = getLocalSuggestions(newValue);
    if (local.length > 0) {
      setSuggestions(local);
      setOpen(true);
      return;
    }
    if (newValue.trim().length > 1) {
      suggestSuppliersRemote(newValue).then(remote => {
        setSuggestions(remote);
        setOpen(remote.length > 0);
      });
    } else {
      setOpen(false);
    }
  };

  const handleBlur = () => {
    setTimeout(() => {
      if (!selectingRef.current) setOpen(false);
      selectingRef.current = false;
    }, 200);
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={e => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
        className={`w-full rounded-sm border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent) ${
          highlighted ? "border-(--color-accent) bg-(--color-accent)/5" : "border-(--color-border-standard)"
        }`}
      />
      {matchedByInitialLabel && <p className="mt-0.5 text-xs text-(--color-accent)">Matched by initial: {matchedByInitialLabel}</p>}
      {open && suggestions.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) shadow-lg">
          {suggestions.map((s, i) => (
            <div
              key={i}
              onMouseDown={() => {
                selectingRef.current = true;
                onSelectSuggestion(s);
                setOpen(false);
              }}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-(--color-surface)"
            >
              <div className="font-medium text-(--color-ink)">{s.name}</div>
              {s.contactInfo && <div className="text-xs text-(--color-ink-tertiary)">{s.contactInfo}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
