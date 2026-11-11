# Sales History Epic

**Status**: 🚧 BUILT (2026-11-10), reviewed by dev-67. Not merged; the production import waits on the owner's go.
**Goal**: know how fast each product sells and when the stores are busy, from every Square order since 2020

## Overview

The app records sales only since go-live, so "how fast it sells", a dead-stock caution and busy hours had no history. Square holds every closed order back to 2020-07-17 (about 111k orders across Lolita and Oriente). A one-time import copies them into `SalesHistoryLine`, kept apart from `Sale`: historical sales never consume FIFO lots or touch COGS and P&L, because the cutover already counted that stock. Asked for by farmacia-ios for the product detail and Reportes.

---

## Import Square History

`npm run import-sales-history -w apps/api` (dry run, counts only), `-- --yes` saves.

**Requirements**:
- Given the stores' completed Square orders, should save one line per item at its store, mapped to a product when the variation is mapped, kept with no product otherwise (custom amounts, unmapped items)
- Given a Square return, should save each returned line as a negative line
- Given an order at a Square location the app doesn't have, should skip it
- Given a run that stops, should resume from the last order saved when run again, saving no line twice (unique order + line uid)
- Given no `--yes`, should count and save nothing
- Given a weighed quantity, should round it to whole units (the stores sell whole units)

---

## Sales Velocity

`GET /products/:id/sales-velocity?locationId=` → `{ lastSoldAt, unitsLast30d, unitsLast90d, daysSinceLastSale }`, any role (units only, no costs).

**Requirements**:
- Given imported history and live sales, should count each order once, net of returns, at that store only
- Given an order recorded live and imported too, should count the live one: matched by payment (`Sale.squareId` is the payment id, not the order id), by refund for an exchange, and by return line (`square-return-line:<uid>`)
- Given a sale last night read this morning, should say 1 day: calendar days on the store clock
- Given an unknown product, should refuse with 404

---

## Busy Hours

`GET /inventory/reports/busy-hours?locationId=&days=90` → `{ timezone, cells: [{ dayOfWeek, hour, orders }] }`, owner and manager.

**Requirements**:
- Given orders over the last `days` (1–730), should count each order once by day of week and hour it closed
- Given any order, should count it whatever its lines: products, custom amounts and Yastás payments alike (the owner's call)
- Given a live payment with both a sale and Yastás lines, should count it once
- Given the stores' clock, should read times in Mexico City time (the owner's call; both Square locations were switched from America/Chicago to America/Mexico_City to match)

---

## Follow-ups

- [ ] Merge and deploy (adds the `SalesHistoryLine` table)
- [ ] Production import: dry run, send dev-67 the counts, then `--yes` on the owner's go (all history)
- [ ] Check busy hours' query plan against the imported data (`EXPLAIN`)
- [ ] Split tender: only the first tender is matched to a live Sale (`ponytail:` comment); store every tender if the stores take split payments
- [ ] Store-wide dead-stock list, if iOS needs one (`GET /inventory/reports/dead-stock`); today it's per product on the detail
