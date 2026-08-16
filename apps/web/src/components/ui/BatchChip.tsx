/**
 * The signature element: every core entity in this app is a discrete batch
 * (a FIFO inventory lot, an extraction batch, a cost approval) with a date
 * and a state. One small stamped-tag chip renders both — reused across
 * Inventory, Inventory Aging, and the Cutover wizard/overview instead of
 * each screen inventing its own badge.
 *
 * Age buckets match the app's own aging report exactly (inventory-reports
 * .service.ts: <30 / 30-60 / 60-90 / >90 days from `receivedAt`), so this
 * chip and the Inventory Aging report never disagree about what "aging"
 * means.
 */
type AgeChipProps = { variant: "age"; receivedAt: string };
type StatusChipProps = {
  variant: "status";
  status: "pending" | "approved" | "locked" | "rejected";
  label?: string;
};
type BatchChipProps = AgeChipProps | StatusChipProps;

const AGE_BUCKET_STYLES = {
  fresh: "border-(--color-border-standard) text-(--color-ink-secondary)",
  watch: "border-(--color-warning) text-(--color-warning)",
  aging: "border-(--color-warning) bg-(--color-warning-bg) text-(--color-warning)",
  stale: "border-(--color-destructive) bg-(--color-destructive-bg) text-(--color-destructive)",
} as const;

const STATUS_STYLES: Record<StatusChipProps["status"], string> = {
  pending: "border-(--color-border-standard) text-(--color-ink-secondary)",
  approved: "border-(--color-success) bg-(--color-success-bg) text-(--color-success)",
  locked: "border-(--color-accent) bg-(--color-accent)/10 text-(--color-accent)",
  rejected: "border-(--color-destructive) bg-(--color-destructive-bg) text-(--color-destructive)",
};

function ageBucket(days: number): keyof typeof AGE_BUCKET_STYLES {
  if (days >= 90) return "stale";
  if (days >= 60) return "aging";
  if (days >= 30) return "watch";
  return "fresh";
}

export function BatchChip(props: BatchChipProps) {
  if (props.variant === "age") {
    const days = Math.floor((Date.now() - new Date(props.receivedAt).getTime()) / 86_400_000);
    const bucket = ageBucket(days);
    return (
      <span
        className={`tabular inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${AGE_BUCKET_STYLES[bucket]}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        {days}d
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[props.status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {props.label ?? props.status}
    </span>
  );
}
