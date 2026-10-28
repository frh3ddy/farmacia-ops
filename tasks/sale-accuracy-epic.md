# Sale Accuracy Epic

**Status**: 📋 PLANNED
**Goal**: A sale's revenue, stock and cost stay true after custom amounts, returns and non-completed payments.

## Overview

Follows the open questions in `tasks/worker-hardening-epic.md`, answered by the owner on 2026-10-27:

- **Returns** happen both ways: in Square (needs the owner's PIN) or by hand when the owner is away. Today neither puts revenue back, and only a manual `RETURN` adjustment puts stock back.
- **Payment status**: checked 2026-10-27 through the Square MCP (read-only payments list; the events search needs a scope the connector lacks). 300 payments across both locations, Oct 16–27: all CASH, all COMPLETED, none refunded. A cash payment is created COMPLETED, so there's nothing to filter. Dropped from this epic — revisit only if the tills start taking cards (delayed capture can create a payment as APPROVED).
- **Custom amounts**: staff use them when an item has no barcode and they can't recall its name, typing a description. Today the line is skipped, so revenue is short and an all-custom order fails.
- **Tax**: Square charges $0 tax for now, so a line's `totalMoney` is the pre-tax price. No change; revisit if tax is turned on.

---

## ✅ Record custom-amount lines for later matching

**Requirements**:
- Given a sale with a custom-amount line, should record its description and amount, count it in the sale's revenue, and leave its cost pending
- Given an order with only custom-amount lines, should record the sale instead of failing
- Given the owner or a manager matching a pending line to a product, should consume FIFO stock for it at the sale's location and update the sale's cost and profit
- Given pending lines, should list them per location with description, amount and date, newest first
- Given a pending line, should keep the nightly books check balanced (no stock moved until it is matched)

Square check (2026-10-27): 500 orders Oct 17–27 had one custom-amount line (`item_type: CUSTOM_AMOUNT`, $16, no name or note) and it was the whole order, so the worker couldn't record it. Description comes from the line's `name`, else its `note`.

Progress:
- ✅ Recording — `toSaleLines` returns `customLines`; the worker writes them as `UnmatchedSaleLine` rows and counts them in revenue (migration `20261028130000_unmatched_sale_line`).
- ✅ Matching — `POST /api/sales/unmatched-lines/:id/match` (owner/manager, own location) queues a `match-sale-line` job on the `sales` queue; the worker's `processMatchJob` runs the sale's FIFO path and adds the cost (migration `20261028140000_unmatched_sale_line_match`). `GET /api/sales/unmatched-lines` lists pending lines.
- ✅ Screen — Ops → "Montos sin producto" (`UnmatchedLinesScreen.tsx`) lists pending lines and assigns a product, reusing Sueltos' `ProductPicker`.

---

## Record Square refunds

**Requirements**:
- Given a Square refund on a recorded sale (`refund.created` / `refund.updated` reaching COMPLETED), should reduce that sale's revenue by the refunded amount, once per refund id
- Given a refund with returned line items, should put each returned item back into stock as a `RETURN` batch at the cost it was sold at
- Given a refund without line items (amount only), should reduce revenue without moving stock
- Given the webhook, should queue refund events durably like payments (2xx only after queueing, idempotent on `event_id`)
- Given the nightly sales check, should flag a Square refund with no matching record

---

## Employee returns screen (by hand)

**Requirements**:
- Given any employee (not only managers) at their location, should find a recent sale and return some or all of its items, with a reason — the owner decided employees can do returns without the owner's PIN, so the audit list below is the control
- Given a return, should put the items back into stock at their sold cost and reduce the sale's revenue, using the same path as Square refunds
- Given a return, should record who made it and when; the owner sees all returns per location
- Given an item returned more times than it was sold on that sale, should refuse it
