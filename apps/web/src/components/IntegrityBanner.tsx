import { useEffect, useState } from "react";
import { apiFetch } from "../lib/apiFetch";
import { useAuth } from "../lib/auth/AuthContext";

type Check = { status: "ok" | "failed"; error?: string; mismatches: unknown[] };
type IntegrityRun = { ranAt: string; checks: { books: Check; sales: Check; fifo: Check } };

const STALE_MS = 2 * 24 * 60 * 60 * 1000;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What last night's integrity check (apps/worker/src/integrity-run.ts) found,
 * for owners: mismatches, checks that couldn't run, or no recent run at all.
 * Nothing after a clean run.
 */
export function IntegrityBanner({ now = new Date() }: { now?: Date }) {
  const { user } = useAuth();
  const isOwner = user.currentLocation?.role === "OWNER";
  const [run, setRun] = useState<IntegrityRun | null | undefined>(undefined);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (!isOwner) return;
    apiFetch<{ data: IntegrityRun | null }>("/inventory/reports/integrity")
      .then(body => setRun(body.data))
      .catch(() => setRun(undefined)); // a failed fetch is not a finding; stay quiet
  }, [isOwner]);

  if (!isOwner || run === undefined) return null;

  const messages: string[] = [];
  if (!run || now.getTime() - new Date(run.ranAt).getTime() > STALE_MS) {
    messages.push(`The nightly integrity check hasn't run${run ? ` since ${new Date(run.ranAt).toLocaleString()}` : " yet"}.`);
  } else {
    const { books, sales, fifo } = run.checks;
    const found = [
      books.mismatches.length && plural(books.mismatches.length, "stock record doesn't add up", "stock records don't add up"),
      sales.mismatches.length && plural(sales.mismatches.length, "Square payment has no sale", "Square payments have no sale"),
      fifo.mismatches.length && plural(fifo.mismatches.length, "sale skipped an older batch", "sales skipped an older batch"),
    ].filter(Boolean);
    if (found.length) messages.push(found.join(" · "));
    for (const [name, check] of Object.entries(run.checks)) {
      if (check.status === "failed") messages.push(`The ${name} check couldn't run (${check.error}).`);
    }
  }
  if (messages.length === 0) return null;

  const details = run ? Object.entries(run.checks).flatMap(([name, c]) => c.mismatches.map(m => `${name}: ${JSON.stringify(m)}`)) : [];

  return (
    <div role="alert" className="mb-4 rounded-md border border-(--color-warning) bg-(--color-warning-bg) px-4 py-3 text-sm text-(--color-warning)">
      {messages.map(m => (
        <p key={m}>{m}</p>
      ))}
      {details.length > 0 && (
        <>
          <button onClick={() => setShowDetails(s => !s)} className="mt-1 underline hover:opacity-80">
            {showDetails ? "Hide details" : "Show details"}
          </button>
          {showDetails && (
            <ul className="mt-2 max-h-48 list-none overflow-y-auto font-mono text-xs">
              {details.map(d => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
