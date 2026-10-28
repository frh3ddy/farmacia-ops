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

## ✅ Record Square refunds, returns and exchanges

Decision (owner, 2026-10-27): staff do returns in Square (refund permission on their role, Staff → Team → Permissions), so Square's money and stock stay right; the app follows Square. The by-hand screen (task 3) is set aside.

Square check (2026-10-27, MCP, real data):
- A refund carries `payment_id` (our `Sale.squareId`) and `order_id`, a return order with `returns[].return_line_items` (what came back, each with `source_line_item_uid`, the sold line; none has a `catalog_object_id` on a custom amount) and `line_items` (what the customer took instead, for an exchange: VOLFENAC $65 back, Diclofenaco crema $58 out, $7 refunded).
- An exchange where the customer pays the difference is a plain `payment.created` (Oriente, Dulce damy $1 back, Trident $3 out, $2 paid) whose order holds both `line_items` and `returns`; there is no refund.
- Square restocks itself (SOLD → RETURNED_BY_CUSTOMER → IN_STOCK). That restock change carries no refund or order id, so the app can't tell a restocked unit from one that wasn't; it assumes Square restocked.
- Square's test events reuse one `event_id` (`13b867cf-…`) and fake ids, so they only prove the URL and signature; test with a real refund.

**Requirements**:
- ✅ Given `refund.created` or `refund.updated` with status COMPLETED, should queue it (2xx after queueing) and record it once, whichever arrives first; other statuses are ignored
- ✅ Given a returned product line, should take it off the sale it was sold on (found through `source_line_item_uid`) and put the units back as a `RETURN` batch at their sold unit cost
- ✅ Given a returned custom amount, should take its amount off the sale without moving stock — or, once matched to a product, return it like a product
- ✅ Given a refund with no return lines (amount only), should take its amount off the paid sale
- ✅ Given an exchange in a refund, should record what the customer took as a sale keyed on the refund id, with FIFO cost
- ✅ Given an exchange where the customer pays the difference, should record the returns in the payment's order as well as its sale
- ✅ Given a return made in Square, should not push stock to Square and should show as up to date in the returns history
- ✅ Given a return of a line with no recorded sale (sold before recording started), should record nothing and log why

Done: `SaleItem.squareLineUid` (migration `20261028160000_sale_item_square_line`); the webhook queues completed refunds as `square-refund` jobs (`SaleQueue.enqueueRefund`); the worker's `processRefundJob` and `recordSquareReturns`, and `processSaleJob` takes back an order's returns before recording its sale. Each returned line is one `SaleReturn` keyed `square-return-line:<uid>`; an amount-only refund is keyed `square-refund:<id>`.

Square webhook subscription: `refund.created` and `refund.updated` both on (owner added `refund.created` 2026-10-27).

Known gaps:
- A return of something sold before sales recording started puts nothing back in the app's stock, though Square restocks it; the next recount corrects it. Add a plain `RETURN` adjustment at the product's last cost if this turns out to be frequent after go-live.
- If staff turn off restock on an itemized refund in Square, the app still restocks.

---

## ⏸ Employee returns screen (by hand)

Set aside 2026-10-27 on `feature/employee-returns` (not merged): returns go through Square instead. Task 2 builds on this branch's `recordReturn`, `SaleReturn` and `saleItemNet`; the screens and `POST /api/sales/:saleId/returns` can be dropped or kept for owners when task 2 merges.

**Requirements**:
- Given any employee (not only managers) at their location, should find a recent sale and return some or all of its items, with a reason — the owner decided employees can do returns without the owner's PIN, so the audit list below is the control
- Given a return, should put the items back into stock at their sold cost and reduce the sale's revenue, using the same path as Square refunds
- Given a return, should record who made it and when; the owner sees all returns per location
- Given an item returned more times than it was sold on that sale, should refuse it
- Given a return, should leave the books check balanced (each returned item is a `RETURN` adjustment that creates its batch) and show in the COGS and margin reports as units, revenue and cost taken back
- Given a resent return request (same client key), should record it once
- Given a return, should put its units back in Square's stock, like adjustments and recounts do, once even when retried

Design: like matching, the api validates and queues a `record-return` job on the `sales` queue; the worker writes the batch, adjustment, `SaleReturn` and the sale's new totals in one transaction. Returned stock goes in as the newest batch at the item's sold unit cost. Custom-amount lines can be returned only once matched (they have no stock until then). Square's stock count goes up too (`UNLINKED_RETURN → IN_STOCK`, keyed on the adjustment, like the api's adjustments); a Square failure retries the job, and the returns history shows any return Square wasn't updated for.

Done: `SaleReturnsController` (`GET /api/sales/recent`, `POST /api/sales/:saleId/returns` for owner/manager/cashier at their location; `GET /api/sales/returns` for owner/manager), the worker's `processReturnJob` (locks the sale row; migration `20261028150000_sale_return`), COGS and margin reports net of returns (`saleItemNet`), and Ops → "Devoluciones" / "Historial de devoluciones" (`ReturnsScreen.tsx`). Returns count in the sale's period. Square refunds (task 2) should reuse `processReturnJob`.

Known gap (task 1): COGS and margin reports add up sale items, so a pending custom amount shows in P&L revenue but not in those per-product reports until it is matched.
