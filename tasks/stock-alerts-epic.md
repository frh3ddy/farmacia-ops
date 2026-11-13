# Stock Alerts Epic

**Status**: 🚧 IN PROGRESS. O1 and O2 are in production; the owner approved the history and it was saved on 2026-11-12 (98,747 rows). O3 is built on `feature/stock-stats`.
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

## O4–O9

Not started: `stockAlert` on product rows and counts (a paused product counts only as paused, whatever its stock), pause and resume, the alerts list, pause suggestions, equivalents, and the `medicationDefinitionId` coverage report.
