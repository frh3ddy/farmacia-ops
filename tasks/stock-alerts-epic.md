# Stock Alerts Epic

**Status**: 🚧 IN PROGRESS. O1 and O2 are in production; the owner approved the history and it was saved on 2026-11-12 (98,747 rows). O3 is in production (2026-11-12). O4 is built and approved on `feature/stock-alert-level` (deploys after the 2026-11-13 03:00 stats run). O5 is planned on `feature/stock-pause`, branched from O4.
**Goal**: alert only on regular sellers that ran out or are running low, ranked by lost sales; let a product be paused per store; suggest pauses from history for a person to review

## Overview

Asked for by farmacia-ios. The design is `farmacia-ios/docs/stock-alerts-design.md` (decisions in §6) and its epic is `farmacia-ios/tasks/stock-alerts-epic.md`, Part 1, owner-approved 2026-11-11. Today "Bajo" is a fixed 1–9 for every product, so slow movers sitting at 1–3 alert, and a product the supplier can't restock alerts as out of stock forever. Paused is per store and temporary, unlike `isDiscontinued`. Steps run in order: O2 feeds O3, and O3 feeds everything after it.

---

## O1. Schema

Additive migration `20261111120000_stock_alerts`.

**Requirements**:
- Given the stores before the migration, should give each one the approved thresholds (90-day window, 14 days of cover, regular seller in ≥ 4 weeks, slow ≤ 2 units, ≥ 30 days at 0, equivalent ≥ 3 units)
- Given a pause, or a change in what a product's alert is computed from, should re-send the product to the phones' delta sync; a nightly stats rewrite with the same inputs should not
- Given a replacement product that gets deleted, should keep the pause and drop the link

---

## O2. Stock history rebuild

`npm run import-stock-history -w apps/api` is a dry run that prints the report; `-- --yes` saves. `StockDay` only has a row on days the level changed or a restock happened.

**Requirements**:
- Given Square changes before a store's cutover, should replay them: supply into IN_STOCK is a restock, a return adds units without a restock, a count sets the level (a restock when above the replay), and nothing goes below 0
- Given the app's movements from the cutover day on, should walk back from today's stock; receivings and received transfers are restocks
- Given a dry run, should report per store the share of linked items whose replay ends at Square's count, the worst mismatches, the items with no product, and the changes it couldn't place, and save nothing
- Given the owner's OK, should save the history; a nightly worker job (`stock-days`, 03:00 Mexico City) then fills every day since the last stored one

---

## O3. Nightly stock stats

Runs in the same nightly call as the stock days, right after them, over each store's window (`StockAlertSettings.windowDays`) ending yesterday.

**Requirements**:
- Given stock days and sales (Square history and live sales, net of returns), should store per product and store: units sold, weeks with a sale (counted back from yesterday), last sale, the median stock on days in stock, days at 0, stock-outs, and the start of the current run at 0
- Given a day with a sale, should not count it as a day at 0, even when the stock history says 0 (Square let items go negative before the cutover)
- Given the last unit sold yesterday, should count the product at 0 from today
- Given days before a product's first stock day, should not count them at 0, even with sales (a sale proves stock on its own day only)
- Given a product whose sales left the window, should update its stats rather than keep the old ones
- Given stats that didn't change, should upsert without re-sending the product to the phones

---

## O4. Stock alert on product rows, chips and counts

`stockAlert { level: none|low|out, priority, paused, pauseReason, zeroSince }` on list, sync and detail rows at a store (null without one). Computed in the catalog SQL the chips and counts read.

**Requirements**:
- Given a regular seller (sold in ≥ `regularMinWeeks` weeks) at 0, should be `out`, ranked by its rate (units ÷ window days)
- Given a regular seller under its cover (rate × `coverDays`, rounded up) and under its typical stock, should be `low`, ranked by rate ÷ stock; one that normally sits at 1 shouldn't alert at 1
- Given a paused product, a slow mover, or no stats, should be `none`; a paused one says it's paused and why
- Given the chips, should list out of stock as stock at 0 and not paused (latest stock-out first, unknown last), low by alert, paused whatever its stock, and in stock as the rest; `/products/counts` gains `paused`, so in stock = total − out − low − paused
- Given a pause or a stats change, should reach the phones' delta sync
- Given stock that moved since last night's stats, should date the run at 0 today for one that was in stock last night (`ProductStockStats.stockAtEnd`, only from stats computed today; unknown after a missed night) and drop it once restocked
  - Known gap: one that sells out between midnight and the 03:00 stats run is sent to the phones with an unknown start; the server says today after 03:00, but nothing re-sends it until the next night (stores are closed then). If it matters, have `recordStockStats` touch the few products with qty ≤ 0, `stockAtEnd` > 0 and no `zeroSince`.

---

## O5. Pause and resume

A product is paused per store (`ProductStoreStatus.pausedAt`), by an owner or a manager, with a reason. It resumes by hand, or by itself when the store receives it (a receiving or a received transfer), whatever its stock was: a delivery means it's available again (user, 2026-11-13; this replaces the design's "from 0 to > 0", which left a product paused with units still on the shelf paused for good after a restock). Pausing and resuming already re-send the product to the phones (O1 trigger) and show in `stockAlert`, the `paused` chip and its count (O4).

**Decisions**: the automatic resume is a database trigger on the two receive records only: an `InventoryReceiving` insert, and a `TransferLine` getting its `destinationInventoryId`. No write path can skip it, like the product change stamps. A transfer with several lots links them one at a time; the first resumes it and the rest find it already active. The `TRANSFER_IN` adjustment a transfer also writes is not an "adjustment" for this rule; nothing keys on `InventoryAdjustment` or on a batch's `source`. The equivalence linking is written once here (`linkEquivalents`) and reused by O8. It never merges two groups (user, 2026-11-13): one store's pause shouldn't make other products interchangeable everywhere; merging is O8's, done on purpose.

**Requirements**:
- Given an owner or manager pausing a product at a store with a reason (and an optional note), should pause it at that store only and record who and when
- Given a product already paused or resumed before, should overwrite the pause: who, when, reason, note and replacement (null if none given), and clear the last resume's time and cause
- Given a cashier or accountant, or a store the user can't act at, should refuse with 403; staff-facing messages in Spanish
- Given a Yastás service or a discontinued product, should refuse with 400: neither alerts (Yastás is its own workflow), so a pause means nothing
- Given a store that doesn't exist (404) or isn't active (400), or a note that isn't text or is over 500 characters (400), should refuse; a note is trimmed, and a blank one is none
- Given a product the store doesn't sell, an unknown replacement, a replacement that is the product itself, a replacement that couldn't be paused itself (Yastás, discontinued, or not sold at the store), or a replacement with a reason other than `REPLACED_BY_EQUIVALENT`, should refuse with 400 and pause nothing; `REPLACED_BY_EQUIVALENT` without a replacement is allowed
- Given `REPLACED_BY_EQUIVALENT` with a replacement, should put both products in one equivalence group: a new one when neither has a group, or the one that has a group; when both are already in different groups, should keep the replacement on the pause and leave the groups as they are
- Given several products (1 to 200) and one reason, should pause them all in one transaction, or none if any is refused, answering with each row once in the order sent; a refusal names the product and carries its `productId`
- Given a manual resume, should clear the pause and record `MANUAL` and when; given a product that isn't paused, should do nothing
- Given a pause, a bulk pause or a manual resume that succeeds, should answer with the updated product row(s) at that store, in the detail and list shape with `stockAlert`, so the phone updates without a refetch
- Given a receiving or a received transfer of a paused product at that store, should resume it with `STOCK_RECEIVED` in the same transaction, whatever its stock was; at another store, or by an adjustment, a count, or a return, it should stay paused

---

## O6–O9

Not started: the alerts list, pause suggestions, equivalents, and the `medicationDefinitionId` coverage report. A future settings screen must touch the store's products when thresholds change, or phones keep the old alert levels.
