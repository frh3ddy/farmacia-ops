import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type BaseProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

type ConfirmDialogProps = BaseProps &
  (
    | {
        /** The exact phrase the user must type to enable the confirm button —
         * e.g. a location name or "DELETE". Verifies the user is confirming
         * the right item, not just adding friction. */
        confirmPhrase: string;
        mathChallenge?: false;
      }
    | {
        confirmPhrase?: never;
        /** Solve a quick arithmetic problem instead of typing a phrase — friction
         * without requiring the user to know/type an exact string. */
        mathChallenge: true;
      }
  );

function generateChallenge() {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const op: "+" | "×" = Math.random() < 0.5 ? "+" : "×";
  const answer = op === "+" ? a + b : a * b;
  return { a, b, op, answer };
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmPhrase,
  mathChallenge = false,
  confirmLabel = "Confirm",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [challenge, setChallenge] = useState(generateChallenge);

  // The dialog stays mounted (early-returns null while closed) so its state
  // survives being reused for a different item — reset the typed value (and
  // draw a fresh math challenge) each time it opens rather than carrying
  // over the last confirmation's input.
  useEffect(() => {
    if (open) {
      setTyped("");
      if (mathChallenge) setChallenge(generateChallenge());
    }
  }, [open, mathChallenge]);

  if (!open) return null;

  const canConfirm = mathChallenge ? typed.trim() === String(challenge.answer) : typed === confirmPhrase;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-(--color-border-emphasis) bg-(--color-surface-raised) p-5 shadow-none">
        <h2 className="text-base font-semibold text-(--color-ink)">{title}</h2>
        <div className="mt-2 text-sm text-(--color-ink-secondary)">{description}</div>
        <label htmlFor="confirm-dialog-phrase" className="mt-4 block text-xs font-medium text-(--color-ink-tertiary)">
          {mathChallenge ? (
            <>
              Solve{" "}
              <span className="tabular text-(--color-ink)">
                {challenge.a} {challenge.op} {challenge.b}
              </span>{" "}
              to confirm
            </>
          ) : (
            <>
              Type <span className="tabular text-(--color-ink)">{confirmPhrase}</span> to confirm
            </>
          )}
        </label>
        <input
          id="confirm-dialog-phrase"
          autoFocus
          inputMode={mathChallenge ? "numeric" : "text"}
          value={typed}
          onChange={e => setTyped(e.target.value)}
          className="mt-1 w-full rounded-sm border border-(--color-border-standard) bg-(--color-surface-inset) px-3 py-1.5 text-sm text-(--color-ink) focus:border-(--color-accent) focus:outline-none"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-sm border border-(--color-border-standard) px-3 py-1.5 text-sm text-(--color-ink-secondary) hover:bg-(--color-surface)"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`rounded-sm px-3 py-1.5 text-sm font-medium text-(--color-accent-contrast) disabled:cursor-not-allowed disabled:opacity-50 ${
              destructive ? "bg-(--color-destructive)" : "bg-(--color-accent)"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
