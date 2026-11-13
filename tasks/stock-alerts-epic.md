# Stock Alerts Epic

**Status**: 🚧 IN PROGRESS. O1 and O2 are in production; the owner approved the history and it was saved on 2026-11-12 (98,747 rows). O3 is in production (2026-11-12). O4 is built on `feature/stock-alert-level`.
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

---

## O5–O9

Not started: pause and resume, the alerts list, pause suggestions, equivalents, and the `medicationDefinitionId` coverage report. A future settings screen must touch the store's products when thresholds change, or phones keep the old alert levels.
