# Inventory Integrity Epic

**Status**: ✅ COMPLETED
**Goal**: A nightly check proves the app's stock and sales records are whole, so a bookkeeping bug or a lost Square sale is found the next morning instead of never.

## Overview

After a location's cutover the app is the source of truth for its stock and cost (vision.md), so Square's stock counts can't be the check, and with one physical count a year a shrinkage report would have one data point a year. What can go wrong in between is the software: a movement recorded without its batch change (or the reverse), or a Square payment that never became a `Sale` (a missed webhook, a failed job never replayed). The existing reconciliation report can't catch either: it sets `expectedQuantity = currentQuantity`, so every product reads reconciled, and nothing calls it (no web screen; the iOS app defines the endpoints but no screen uses them).

This epic deletes that report and adds a nightly integrity job in the worker: a books check (each product's batches add up to its movements) and a sales check (every Square payment of the day has its `Sale`). It is read-only: it logs, shows a banner in the web app, and never corrects stock or sales by itself.

Cost: one BullMQ job scheduler in the existing worker, a few grouped SQL queries and a few paginated Square calls per night — seconds of work and a few MB, no new service.

Alerts go to the Railway logs and a banner in the web app (decided 2026-10-27).

---

## ✅ Remove the reconciliation report

`GET /inventory/reconciliation/product/:productId` and `/location/:locationId` always answer "reconciled".

**Requirements**:
- Given the product and location reconciliation endpoints, should delete them with `reconcileProduct`, `reconcileLocation` and their types
- Given the FIFO checks in the same controller (`consumption/:productId`, `sale-item/:saleItemId`, `verify-fifo/:saleId`), should keep them working unchanged
- Given the iOS app, should note the two now-unused endpoint cases in `APIEndpoint.swift` for removal there

**iOS follow-up**: remove `reconcileProduct` and `reconcileLocation` from `farmacia-ios/FarmaciaApp/Core/Network/APIEndpoint.swift` (cases and paths); no screen calls them.

---

## ✅ Books check

Prove each stock record adds up, with checks that can actually fail.

Every batch records the movement that created it (`createdByReceiving`, `createdByAdjustment`, `createdByTransferLine`); a batch with none of them is opening stock (cutover or product creation), and `Inventory` keeps only its current `quantity`. Comparing a product's batches to "opening + movements" can't fail for opening stock, because its start can only be rebuilt from the batch itself, so the check works per record instead.

**Requirements**:
- Given a batch created by a receiving, an adjustment or a transfer receipt, should report it when its created quantity − everything consumed from it ≠ its current quantity
- Given a negative adjustment, should report it when its consumption rows don't add up to its quantity
- Given a sale item, should report it when its consumption rows don't add up to the quantity sold
- Given an opening batch, should report it when its quantity is negative
- Given books that add up, should report no mismatch; each mismatch names the record, product, location, expected and actual
- Given all products and locations, should run as one grouped query per check, never one query per product

---

## ✅ Sales check

Every Square payment must have become a `Sale` (`Sale.squareId` is the Square payment id).

**Requirements**:
- Given a day and a location, should list that day's Square payments (paginated) and report each one with no `Sale` of the same `squareId`
- Given a payment whose sale job failed (e.g. `SaleValidationError` for a payment with no order), should report it as a failed job to replay, not as a lost sale
- Given a payment received after the check's cutoff (still in the queue), should not report it
- Given Square unreachable, should log that the check could not run and try again the next night, not retry in a loop (handled by the nightly job: `loadSalesCheck` throws, the job logs it)
- Given sales not being recorded yet (they start only once every location is cut over), should check nothing: only locations with a `CutoverLock`, and only payments after both that location's cutover date and `SALES_RECORDING_STARTED_AT` (a worker variable, set when recording is turned on; unset = no sales check). Added 2026-10-27 (`salesCheckScope`).

---

## ✅ Real FIFO verification

`GET /inventory/reconciliation/verify-fifo/:saleId` can never find a violation: its query sorts a sale item's consumptions by the batch's `receivedAt`, then checks they are in `receivedAt` order (found 2026-10-27 while removing the reconciliation report). No client calls it, so the check moves to the worker as a third nightly check and the endpoint is deleted (decided 2026-10-27).

Consumption rows don't record the order they were taken in (one `createMany`, same `consumedAt`), but batch quantities only ever go down: an older batch that has stock now had at least that much when the sale ran.

**Requirements**:
- Given a sale item that took stock from a batch while an older batch (earlier `receivedAt`) of the same product and location still has stock and already existed when the sale ran (`createdAt` ≤ `consumedAt`), should report a FIFO violation naming both batches
- Given a sale item that consumed its batches oldest `receivedAt` first, should report nothing
- Given an older batch created after the sale (a cutover or transfer batch with an old `receivedAt`), should not report it
- Given a window of sales, should run as a few set-based queries
- Given the api, should delete `verify-fifo/:saleId` and `verifyFIFOCompliance`

---

## ✅ Nightly integrity job

Run both checks every night in the worker and store the result for the web banner.

**Requirements**:
- Given the worker starting, should register one BullMQ job scheduler (`upsertJobScheduler`, idempotent across restarts and deploys) that runs the checks at 03:00 America/Mexico_City
- Given a run, should log one summary line (products checked, payments checked, mismatches) and one line per mismatch
- Given a run, should store its result (when it ran, counts, and each mismatch) so the api can read the latest one; keep only recent runs
- Given a run, should finish in seconds and a few MB, within the worker's memory budget

---

## ✅ Integrity banner in the web app

Show the owner the latest run's problems where they will see them.

**Requirements**:
- Given the latest run, should expose it through an owner-only api endpoint (non-owners get 403)
- Given an owner opening the web app after a run with mismatches, should show a banner naming how many products don't add up and how many payments have no sale, linking to the details
- Given a run with no mismatches, should show no banner
- Given no run in the last 2 days (the job stopped), should show a banner saying the check hasn't run, so a silent failure is visible too
- Given the banner, should follow the web app's existing alert styling (`ErrorBanner` / warning tokens)
