# Epic: Lots with caducidad on Conteo inicial (API)

**Status**: ✅ COMPLETED (deployed 2026-11-05)
**Goal**: a Conteo inicial can record the lots on the shelf (quantity, caducidad, lote), and the expiring list shows them.

## Overview

The migration loaded stock with no lot or caducidad, and today lot info exists only on a receiving
(`InventoryReceiving.batchNumber`/`expiryDate`), joined to its batch's remaining quantity for the expiring list.
A Conteo inicial is when staff see the shelf, so the app (farmacia-ios `tasks/opening-count-lots-epic.md`)
sends the counted lots. Contract and user decisions come from the iOS session (2026-11-05): lots optional, Conteo
inicial only, **replace** the product's lots at that store, FIFO costs untouched.

**Storage: lot fields on the cost batch (`Inventory`), not a separate lot table.** Sales consume batches, so a
lot on a batch shrinks as it sells and the expiring list stays true. A separate lot table would keep showing
units already sold. To replace lots without touching costs, the remaining batches (oldest received first) are
split to fit the lots (soonest caducidad first). Each piece keeps its batch's cost and receivedAt, so FIFO
selling also sells the soonest caducidad first.

---

## Lot on the batch

Add `expiryDate DateTime?` and `lotNumber String?` to `Inventory`. Backfill them from each batch's receiving.
Receiving writes them on the batch it creates.

**Requirements**:
- Given a receiving with caducidad and lote, should save both on the batch it creates
- Given existing receivings, the migration should copy their caducidad and lote onto their batches
- Given a transfer between stores, the batch it creates at the destination should carry its source batch's caducidad and lote

---

## Expiring list reads the batch

`getExpiringProducts` and the batch reports read caducidad and lote from the batch, so counted lots (no receiving) show.

**Requirements**:
- Given a batch with caducidad and stock, and no receiving, should list it in the expiring products
- Given a receiving's batch, should still list it with its supplier

---

## A product's lots at a store

`GET /inventory/lots?productId=…&locationId=…` (OWNER, MANAGER; store from the session by default, own store
only for a manager), so the count form can pre-fill the current lots.

**Requirements**:
- Given batches with stock, should return `[{ quantity, expiryDate: "YYYY-MM-DD" | null, batchNumber | null }]`, soonest caducidad first
- Given batches with the same caducidad and lote, should return them as one lot with their units added
- Given batches with neither caducidad nor lote (migration stock) or with no units left, should leave them out
- Given a manager asking for another store, should refuse with 403

---

## Lots on a Conteo inicial entry

`POST /inventory/stock-counts/:id/entries` takes optional `lots: [{ quantity, expiryDate?, batchNumber? }]`.

**Requirements**:
- Given lots adding up to more than the count, should refuse with 400 and `code: "LOTS_TOTAL_MISMATCH"` and change nothing
- Given lots adding up to less than the count, should save them and leave the rest of the stock without lot info
- Given a lot without caducidad (the lote is optional; user, 2026-11-05), or a quantity that isn't a positive whole number, should refuse with 400
- Given lots 4 (ene-2027) + 6 (mar-2027) for a count of 10, should leave the product's stock at the store as those two lots, with their costs unchanged
- Given a count equal to the stock and lots, should save the entry and replace the lots without an adjustment
- Given no lots, should leave existing lots as they are
- Given a replay with the same clientRequestId, should return the first result and not split again
- Given a sale after a count with lots, should sell the soonest caducidad first
- Given a split batch, the books check should still balance

---

## A product's count in the session

`GET /inventory/stock-counts/:id/entries?productId=…` (OWNER, MANAGER; own store for a manager), so the count
form can show "Ya contado en este conteo" (counts span days).

**Requirements**:
- Given a product counted in the session, should return its counted quantity, when, the counter's name, and its reason and notes
- Given a product not counted, or a session at another store, should return null (200, not 404)

---

## Reason and notes on a Conteo inicial entry

`POST …/entries` takes optional `reason` and `notes` (iOS request, 2026-11-05).

**Requirements**:
- Given a count with reason and notes that changes stock, should keep them trimmed on the entry and its adjustment
- Given a matching count, should keep them on the entry
- Given text over 500 characters, should refuse with 400

---

## Review follow-ups (2026-11-05)

**Requirements**:
- Given a count that replaces lots, should write an audit log row with the previous and the new lots
- Given more than 50 lots in one count, should refuse with 400
- Given a piece split from a batch, should record where it came from and the units it started with, so the books check reconciles it like any batch and the expiring list shows its receiving's supplier
- Given boxes broken into loose units, the loose batch should carry the soonest caducidad of the boxes taken
- Given a sale (FIFO) after a count with lots, should take the soonest caducidad first

---

## Backfill pieces split before they recorded their source

Lot pieces split in production between lots going live (2026-11-05 20:16 UTC) and the deploy that added
`splitFromId`/`splitInitialQuantity` (user chose to backfill; plan corrected by dev-ee).

**Requirements**:
- Given pieces of a batch and of a piece whose units add up to what each split off, should point both at the root with the units each started with
- Given a piece two batches could have split, should leave it without a source
- Given a split's pieces next to another batch in the same second, so the units don't add up, should leave them without a source
- Given a product not counted since lots went live, should leave it alone
- Given a linked piece, should write a BACKFILL_LOT_PIECE audit row with its source and starting units (dev-ee; the deploy log shows no counts — read them at /auth/audit-logs)
