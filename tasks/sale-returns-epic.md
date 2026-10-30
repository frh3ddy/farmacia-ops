# Sale Returns Epic

**Status**: ✅ COMPLETED (2026-10-30)
**Goal**: A return never gives back more than was sold, counts in the month it happened, records the cash a hand return pays out, and never fails without anyone seeing it.

## Overview

From the 2026-10-29 review of `apps/api/src/sales/`. A return checks each line on its own, so one request listing an item twice can give back more than was sold. Returns are subtracted from the original sale's totals, and reports net them into the sale's period, so a November return changes October after it was reviewed; the owner decided a return counts in the month it happened. A return made by hand is paid back in cash outside Square, which the owner wants recorded as a cash note. A return or match that fails in the worker after the api answered "queued" is only written to the worker's log. Smaller: two lists have no limit, a line can be matched to a product the store doesn't sell, some staff-facing errors are English or show an id, and comments and the old epic are stale. Takes over the remaining work of [Sale Accuracy](sale-accuracy-epic.md).

---

## ✅ A return never exceeds what was sold

**Requirements**:
- Given a return listing the same sale item more than once, should add the quantities before checking what is left, in the worker (the authority) as in the api
- Given a total above what is left, should refuse it and change nothing

---

## ✅ Returns count in the month they happened

Sales stay as they were sold; a return is its own dated event (`SaleReturn.returnedAt`, revenue, cost; `SaleReturnItem` per product).

**Requirements**:
- Given a return, hand or from Square, should leave the sale's totals as sold instead of subtracting from them
- Given a period, P&L and the dashboard should show sales of the period, then returns dated in the period as their own line (Ventas − Devoluciones = Ventas netas), with cost and profit following
- Given COGS and margin per product, should net the period's returned units, revenue and cost by product (a product can show negative units in a month of more returns than sales) instead of netting returns into each sale item (`sale-item-net.ts`)
- Given the nightly books check, should keep balancing with returns counted when they happened
- Given returns already recorded the old way, should add their amounts back to their sales once (a migration; check the production count first — sales aren't recorded there until cutover, so likely none)

---

## ✅ A cash note for hand returns

A return made in the app is paid back in cash outside Square.

**Requirements**:
- Given a hand return, should record the cash paid back on the return; a return from a Square refund records none (Square paid it)
- Given the returns history, should show each hand return's cash
- Given a day and store, should total the cash paid back for returns, so the cash drawer can be squared

---

## ✅ Failures someone can see

**Requirements**:
- Given a queued hand return or line match that the worker gives up on (refused, or Square failing after its retries), should record it with its Spanish reason where the owner's screens show it
- Given the returns and pending-lines screens, should show those failures, so "queued" never silently means "never recorded"

---

## ✅ Small fixes

**Requirements**:
- Given the recent-sales and pending-lines lists, should return at most a fixed number, newest first; a negative or zero `days` should fall back to the default
- Given a match to a discontinued product, or to another store's one-store product, should refuse it
- Given "Sale not found" and "Sale line not found", should answer in Spanish; a return over what's left should name the product, not the sale item id
- Given `SaleReturnsController`'s docblock, should say returns by hand are the owner's
- Given the old [Sale Accuracy](sale-accuracy-epic.md) epic, close it: its paused returns task (built owner-only) points here

---

## ✅ Tests

**Requirements**:
- Given each case above, should be covered: an item listed twice, a return in a later month leaving the earlier month unchanged in P&L, dashboard, COGS and margin, the books check across months, the cash note and its daily total, a recorded failure, the list limits and the match refusals

---

Done: the worker sums a request's items before checking (`recordReturn`), records `SaleReturn.cashRefunded` for returns by hand and no longer touches the sale; migration `20261031120000_returns_in_their_own_month` adds the column, fills it for earlier hand returns and puts earlier returns back on their sales (production count not checked — the add-back is correct for any count). COGS and margin net returned units by product on the day they came back (`returnedLines`; `sale-item-net.ts` removed); the P&L shows `revenue.sales`, `returns`, `netSales` and `costOfGoodsSold.returns`; the dashboard's `netProfit.salesRevenue` stays net (so current clients add up) with `salesReturns` beside it. `GET /api/sales/returns` adds `cashByDay` (31 days, per Mexico City day and store) and `failed` (failed `record-return` jobs never recorded, from BullMQ's 30-day failed set); pending lines carry `matchError`. The books check is a stock check, unaffected by money; the worker tests assert it stays clean after returns.

Follow-up: a "Devoluciones" row on the iOS dashboard's P&L card from `netProfit.salesReturns` (farmacia-ios was mid-branch with uncommitted work).
