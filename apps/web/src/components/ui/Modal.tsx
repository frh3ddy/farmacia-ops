import { useEffect, type ReactNode } from "react";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * Generic bordered-scrim modal — same depth strategy as ConfirmDialog
 * (border + backdrop, no shadow), just without the typed-confirmation flow
 * that's specific to destructive actions. Use ConfirmDialog for those; use
 * this for any other "step out of the page to edit/view something" modal.
 *
 * Deliberately NOT portaled to document.body (unlike ConfirmDialog) — no
 * functional need to portal here (nothing between this and its caller sets
 * transform/filter/overflow that would clip a `fixed` element), and staying
 * a DOM descendant is one less thing to think about if a caller ever needs
 * a locally-scoped CSS override again.
 */
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg border border-(--color-border-emphasis) bg-(--color-surface-raised)"
      >
        <div className="flex items-center justify-between border-b border-(--color-border-standard) px-5 py-3">
          <h2 className="text-base font-semibold text-(--color-ink)">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm px-1.5 py-0.5 text-(--color-ink-tertiary) hover:bg-(--color-surface) hover:text-(--color-ink)"
          >
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-(--color-border-standard) px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
