import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const [menuRect, setMenuRect] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const selectingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const MENU_MAX_HEIGHT = 240; // matches max-h-60

  useEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const spaceBelow = window.innerHeight - rect.bottom;
      const flipUp = spaceBelow < MENU_MAX_HEIGHT && rect.top > spaceBelow;
      setMenuRect(
        flipUp
          ? { bottom: window.innerHeight - rect.top, left: rect.left, width: rect.width }
          : { top: rect.bottom, left: rect.left, width: rect.width }
      );
    };
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [open]);

  const loadSuggestions = (forValue: string) => {
    const local = getLocalSuggestions(forValue);
    if (local.length > 0) {
      setSuggestions(local);
      setOpen(true);
      return;
    }
    if (forValue.trim().length > 1) {
      suggestSuppliersRemote(forValue).then(remote => {
        setSuggestions(remote);
        setOpen(remote.length > 0);
      });
    } else {
      setOpen(false);
    }
  };

  const handleChange = (newValue: string) => {
    onChange(newValue);
    loadSuggestions(newValue);
  };

  const handleFocus = () => loadSuggestions(value);

  const handleBlur = () => {
    setTimeout(() => {
      if (!selectingRef.current) setOpen(false);
      selectingRef.current = false;
    }, 200);
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => handleChange(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        className={`w-full rounded-sm border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-(--color-accent) ${
          highlighted ? "border-(--color-accent) bg-(--color-accent)/5" : "border-(--color-border-standard)"
        }`}
      />
      {matchedByInitialLabel && <p className="mt-0.5 text-xs text-(--color-accent)">Matched by initial: {matchedByInitialLabel}</p>}
      {open &&
        suggestions.length > 0 &&
        menuRect &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: menuRect.top,
              bottom: menuRect.bottom,
              left: menuRect.left,
              width: menuRect.width,
            }}
            className={`z-20 max-h-60 overflow-auto rounded-md border border-(--color-border-standard) bg-(--color-surface-raised) shadow-lg ${
              menuRect.bottom !== undefined ? "mb-1" : "mt-1"
            }`}
          >
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
          </div>,
          document.body
        )}
    </div>
  );
}
