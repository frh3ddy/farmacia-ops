import { useState, type ReactNode } from "react";

type TooltipProps = { label: string; children: ReactNode };

/** Minimal hover/focus tooltip — floats `label` above the trigger. The
 * trigger itself (an icon button, usually) owns its own accessible name;
 * this only adds the supplementary hint text. */
export function Tooltip({ label, children }: TooltipProps) {
  const [visible, setVisible] = useState(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-sm border border-(--color-border-standard) bg-(--color-surface-raised) px-2 py-1 text-xs text-(--color-ink) shadow-lg"
        >
          {label}
        </span>
      )}
    </span>
  );
}
