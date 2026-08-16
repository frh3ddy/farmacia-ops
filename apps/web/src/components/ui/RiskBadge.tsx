import type { RiskLevel } from "../../lib/reports/types";

const STYLES: Record<RiskLevel, string> = {
  LOW: "border-(--color-border-standard) text-(--color-ink-secondary)",
  MEDIUM: "border-(--color-warning) text-(--color-warning)",
  HIGH: "border-(--color-warning) bg-(--color-warning-bg) text-(--color-warning)",
  CRITICAL: "border-(--color-destructive) bg-(--color-destructive-bg) text-(--color-destructive)",
};

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold uppercase ${STYLES[level]}`}>
      {level}
    </span>
  );
}
