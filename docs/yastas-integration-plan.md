# Yastás integration — implementation brief

Handoff prompt for a Claude Code terminal session in this repo. This is the
output of a design discussion (not yet implemented) — read this whole file,
then implement it. Use `graphify query`/`graphify explain` per this repo's
CLAUDE.md before diving into unfamiliar files, and run `graphify update .`
after making changes.

## Background

The pharmacy is a "punto Yastás" — an affiliated banking-correspondent point
for Gentera/Compartamos's Yastás network. Customers do banking-style
operations through the pharmacy: bill payments, phone topups, remittances,
loan payments (money IN — client pays the pharmacy), and withdrawals (money
OUT — pharmacy hands cash to the client, reimbursed electronically). The
pharmacy earns a small commission per operation, known only once Yastás
sends a periodic settlement report — not at the time of the operation. To
perform these operations, the pharmacy preloads a cash balance ("float")
into its own Yastás account, which every operation draws down or tops back
up at par value (no unit cost).

**Core principle, non-negotiable:** none of this should ever touch `Sale`,
`SaleItem`, `InventoryConsumption`, or FIFO cost logic. It is not
merchandise, it has no COGS, and mixing it into product-level revenue/margin
reporting would corrupt those numbers. Everything below is deliberately
modeled as its own parallel ledger.

## Confirmed current POS workflow

**IN operations** (client pays the pharmacy): the employee performs the
operation, charges the client, then rings a per-employee Square catalog
item (e.g. "yastas-lolita") using Square's `VARIABLE_PRICING` (open price
entered at checkout) with the face amount (e.g. $100). This is intentional
and correct — the cash really does enter the drawer, so it belongs in
Square's own till reconciliation too. Confirmed via Square's API schema:
`CatalogItemVariation.pricing_type: VARIABLE_PRICING` is exactly this
feature — no change needed to how these are rung up.

**OUT operations / withdrawals** (pharmacy pays the client): these are
deliberately NEVER rung through Square. Ringing a withdrawal as a normal
Square sale would make Square's own expected-cash-at-close calculation go
UP by that amount (Square treats every line item as cash received), while
the real drawer cash goes DOWN by that amount — a direct contradiction.
Today, OUT tracking is 100% physical/manual: Yastás prints a receipt with
a reference number, the employee adds a handwritten note, and at end of day
it's checked against the Yastás portal. There is currently no digital
record of OUT operations anywhere in this app.

Cash-source note (decided, do not build further than this): a withdrawal's
cash can come from an employee's personal loose-change fund, the drawer's
opening float, or the day's accumulated sales cash. We are tracking only
the **total** withdrawal amount, not a per-source breakdown — those pools
are fungible once mixed in the till anyway, and this app has no
till/shift/employee-cash-fund model to build that on. Do not add one for
this feature.

Employee attribution: Square's `Order`/`Payment` objects have no reliable
link to this app's own `Employee` PIN-login system (`Payment.team_member_id`
exists but only populates via Square's own Team Member accounts, which this
app doesn't use — confirmed via Square API schema, not assumed). So:
- IN: employee is resolved from *which* per-employee catalog item was hit.
- OUT: employee comes for free from the authenticated PIN session on the
  manual-entry endpoint — no name-parsing needed.

Inter-location wallet transfers: Yastás supports transferring balance
between the pharmacy's own locations' Yastás accounts, confirmed **instant**
(no processing delay) — so no pending/in-transit state is needed. Only
`OWNER`, `MANAGER`, or `ACCOUNTANT` roles (existing `EmployeeRole` enum) may
initiate one; `CASHIER` cannot.

## Data model changes (prisma/schema.prisma)

Reuse existing naming conventions in this schema wherever a precedent
exists — don't invent new vocabulary where one already fits.

1. **Non-inventory flag** on the catalog side, e.g. `Product.tracksInventory
   Boolean @default(true)`, or a dedicated `Category` ("Yastás") the worker
   can check instead. Only the per-employee IN-direction catalog items get
   flagged; there is no "Retiro"/OUT catalog item (OUT never touches Square,
   see above — do not create one).

2. **`YastasOperation`** — the operation ledger, NOT `Sale`/`SaleItem`:
   - `id`, `employeeId` (FK → `Employee`), `locationId` (FK → `Location`)
   - `squareOrderId` (nullable — set only for IN rows)
   - `yastasReceiptRef` (nullable String — Yastás's own receipt/operation
     reference, lets day-end reconciliation match specific rows to specific
     portal entries instead of just comparing daily totals)
   - `direction` (enum `IN` | `OUT`)
   - `faceAmount` (Decimal — the amount entered at POS or on the manual
     entry; NOT revenue)
   - `occurredAt` (DateTime)
   - Zero relation to `Sale`/`SaleItem`/`Inventory`.

3. **`YastasWallet`** — one balance per location:
   - `id`, `locationId` (FK, likely unique — one wallet per location),
     `balance` (Decimal, denormalized running total for fast reads)

4. **`WalletMovement`** — the wallet's ledger (mirrors how `Inventory`/
   `InventoryAdjustment` track movements, and reuses the
   `TRANSFER_OUT`/`TRANSFER_IN` vocabulary already used by the existing
   `Transfer`/`AdjustmentType` for inventory):
   - `id`, `walletId` (FK → `YastasWallet`)
   - `type` (enum: `OPENING_BALANCE`, `LOAD`, `OPERATION_DEBIT`,
     `OPERATION_CREDIT`, `TRANSFER_OUT`, `TRANSFER_IN`)
   - `amount` (Decimal, signed)
   - `relatedOperationId` (nullable FK → `YastasOperation`, set for
     OPERATION_DEBIT/OPERATION_CREDIT)
   - `relatedTransferId` (nullable FK → `YastasWalletTransfer`, set for
     TRANSFER_OUT/TRANSFER_IN)
   - `createdAt`
   - App-level rule (not a DB constraint unless easy to add): at most one
     `OPENING_BALANCE` movement per wallet, ever.

5. **`YastasSettlement`** — the only place revenue actually gets booked:
   - `id`, `locationId`, `periodStart`, `periodEnd` (make these generic, NOT
     a hardcoded "month" — daily settlement is periodStart == periodEnd and
     should be fully supported)
   - `amountEarned` (Decimal — the commission Yastás reports, at zero cost)
   - `status` (enum, e.g. `PROVISIONAL` | `CONFIRMED`, or separate
     `reportedAt`/`paidAt` timestamps) — Yastás's daily figure can be a
     running total that gets revised before actual payout; don't silently
     restate a past day's booked revenue when that happens.
   - Optionally link to the `YastasOperation` rows it reconciles against.
   - Feeds top-line revenue/net profit in reports; explicitly EXCLUDED from
     per-product COGS/margin calculations.

6. **`YastasWalletTransfer`** — instant, so no status lifecycle needed:
   - `id`, `fromLocationId`, `toLocationId`, `amount`, `initiatedAt`,
     `createdBy` (FK → `Employee`, must have role OWNER/MANAGER/ACCOUNTANT —
     enforce this in the service layer, not just in the UI)
   - On creation, posts BOTH `WalletMovement` rows (`TRANSFER_OUT` at
     source, `TRANSFER_IN` at destination) atomically in one DB transaction.

## Backend changes

- `apps/worker/src/sale.worker.ts` / `apps/worker/src/catalog.mapper.ts`:
  before the existing FIFO/`InsufficientInventoryError` path runs, check
  whether the mapped product/category is non-inventory-tracked. If so,
  branch entirely: skip `mapVariationToProduct`'s FIFO consumption, create
  a `YastasOperation` (direction `IN`) + `WalletMovement`
  (`OPERATION_DEBIT`) instead of a `Sale`/`SaleItem`, and resolve
  `employeeId` from the per-employee item. Never let this path throw
  `UnmappedVariationError`/`InsufficientInventoryError` — those are for
  merchandise only.
- New authenticated endpoint (used by whichever client — iOS app or web
  ops tool — has the PIN session) for logging an OUT operation directly:
  takes `faceAmount`, `yastasReceiptRef` (optional), `locationId`; reads
  `employeeId` from the session; writes `YastasOperation` (direction `OUT`)
  + `WalletMovement` (`OPERATION_CREDIT`) in one transaction. No Square
  involvement at all.
- New endpoint for `YastasWalletTransfer`, gated to
  `OWNER`/`MANAGER`/`ACCOUNTANT` roles, posting both movements atomically.
- New endpoint/flow for entering a `YastasSettlement` when Yastás's report
  arrives (manual entry is fine for v1 — no need to build an importer).
- Reporting: extend whatever computes P&L/net profit (see
  `apps/api/src/inventory/inventory-reports.service.ts` for the existing
  revenue/COGS pattern) to add `YastasSettlement.amountEarned` as a
  separate "service revenue" line, included in net profit but excluded
  from per-product gross-margin calculations.
- Cutover: on go-live, read the pharmacy's actual current balance from the
  Yastás portal and record one `WalletMovement` (`OPENING_BALANCE`) for
  that exact amount per location, dated to the cutover day. No cost-basis
  estimation needed (unlike the existing inventory cutover) — it's a live,
  exact number. Do not reuse the `Cutover`/`CutoverLock` models — those are
  for the batched, owner-approved historical-cost inventory migration and
  are unnecessary overhead here.

## Testing plan

- Use the existing dev-tools webhook simulator
  (`apps/web/src/sections/dev-tools/WebhookTestScreen.tsx`,
  `SalesTestScreen.tsx`, `apps/api/src/webhooks/webhook-test.service.ts`) to
  simulate a Square order hitting a "yastas-<employee>" item, and verify:
  no `Sale`/`SaleItem`/`InventoryConsumption` rows are created, exactly one
  `YastasOperation` (direction IN) and one `WalletMovement`
  (OPERATION_DEBIT) are, and the wallet balance moves by the right amount.
- Manually test the OUT entry endpoint the same way (no Square involved),
  confirming `WalletMovement` direction and sign.
- Test `YastasWalletTransfer` for both a successful transfer by an
  authorized role and a rejected attempt by `CASHIER`.
- Confirm existing merchandise sales still process exactly as before (this
  change must be additive/branching, never touching the existing
  `Sale`/`SaleItem`/FIFO path for real inventory items).

## Explicit non-goals (do not build these)

- No second Square catalog item for withdrawals ("Yastás Retiro") — OUT
  never touches Square.
- No adoption of Square Team Member accounts / `Payment.team_member_id` —
  the PIN session already solves attribution for OUT, and the per-employee
  item already solves it for IN.
- No till/shift/employee-cash-fund model — cash-source breakdown for
  withdrawals was explicitly descoped; total amount only.
- No reuse of `Cutover`/`CutoverLock` for the wallet's opening balance —
  that machinery is for the historical-cost inventory migration.
- Don't add `employeeId` to `Sale`/`SaleItem` as part of this work unless a
  separate need for it comes up — it's out of scope for Yastás specifically.

## One thing to verify before writing Square-facing code

Before touching anything in `apps/worker/src/sale.worker.ts` that talks to
Square's Orders/Payments/Catalog shapes, don't rely on memory for exact
field names/nesting — ground it against the Square MCP (`get_type_info`)
or a fresh docs fetch first, the same way this was verified during design
(`CatalogItemVariation.pricing_type`, `Payment.team_member_id`, etc. were
all checked against live schema, not assumed).
