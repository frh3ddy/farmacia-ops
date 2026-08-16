# farmacia-ops back-office design system

Applies to `apps/web` (the back-office tool suite: Ops, Cutover, Reports, Dev Tools).
Not the customer-facing/iOS app — that's a separate consumer product with its own design skills.

## Direction

The back-office/ledger side of the business, not a consumer dashboard: precise
operations tool, dense, structured, quiet. Reads like a stockroom ledger/audit
trail, not a soft SaaS dashboard.

**Domain concepts:** FIFO batch/lot, receiving, invoice/cost basis, cutover
lock (a ledger closing), owner sign-off, shrinkage, aging shelf stock, POS
sync, multi-location chain, audit trail.

**Signature element:** the batch chip (`BatchChip`, `apps/web/src/components/ui/BatchChip.tsx`)
— every core entity here is a discrete batch with a received date and a
state. One chip renders both an age-from-received reading (matching the
app's own aging buckets: <30 / 30-60 / 60-90 / >90 days) and an
approval/lock status, reused across Inventory, Inventory Aging, and Cutover
instead of a generic badge per screen.

**Defaults rejected:** generic gradient stat cards → flat ledger stat tiles
with monospace tabular numerals; top tab bar → grouped sidebar nav (Ops /
Cutover / Reports / Dev Tools); native `confirm()`/`alert()` for destructive
actions → `ConfirmDialog` (type a phrase to proceed).

## Depth strategy

Borders-only. No shadows. Matches "dense operations tool," not "approachable
consumer app." (`ConfirmDialog`'s modal uses a border + scrim, not a shadow.)

## Tokens

Defined in `apps/web/src/styles/index.css` via Tailwind v4's `@theme` block —
every component should use these, never a raw hex.

| Token | Value | Use |
|---|---|---|
| `--color-canvas` | `#f3efe6` | page background, sidebar |
| `--color-surface` | `#f8f5ee` | cards, main content area |
| `--color-surface-inset` | `#ece7d9` | inputs (things that receive content) |
| `--color-surface-raised` | `#fffdf8` | modals, dropdowns (one level above parent) |
| `--color-ink` / `-secondary` / `-tertiary` / `-muted` | warm charcoal, 4 levels | text hierarchy |
| `--color-border-subtle/standard/emphasis` | low-opacity warm rgba | border progression, matched to importance |
| `--color-accent` / `-hover` / `-contrast` | stamp-ink navy `#1f3a5f` | primary actions, focus rings, audit/approval chrome |
| `--color-success` / `-bg` | ledger green `#2f6b4f` | approved/reconciled |
| `--color-warning` / `-bg` | amber `#9c6a0f` | aging stock, pending approval |
| `--color-destructive` / `-bg` | hazard red `#a3271f` | destructive actions, locked state, shrinkage — reserved, not spread across generic error text |

**Typography:** `--font-sans` (system-ui stack — no CDN font dependency, part
of killing the CDN-script architecture) for UI text; `--font-mono` (`.tabular`
utility class) for every money/quantity/ID value so columns of numbers align.

**Radius:** Tailwind defaults — `rounded-sm` inputs/buttons, `rounded-md`
cards/tables, `rounded-lg` modals. Not customized; the defaults already fit.

**Spacing:** Tailwind's default 4px-based scale. Not customized.

## Reusable components (`apps/web/src/components/ui/`)

- `Table<T>` — generic columns/render-prop table, replaces repeated `<table>` markup.
- `LocationPicker` (+ `useLocations` hook) — the one place a location dropdown is implemented; never hardcode a location id as a default again.
- `ConfirmDialog` — typed-phrase confirmation for irreversible actions (catalog cleanup, cutover lock, batch rejection).
- `BatchChip` — age/status chip, see Signature element above.

Add a pattern here when a component is used 2+ times or has a specific
measurement worth remembering — not for one-off screens.
