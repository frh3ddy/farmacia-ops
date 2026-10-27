# Inventory Integrity Epic

**Status**: 📋 PLANNED
**Goal**: A nightly check proves the app's stock and sales records are whole, so a bookkeeping bug or a lost Square sale is found the next morning instead of never.

## Overview

After a location's cutover the app is the source of truth for its stock and cost (vision.md), so Square's stock counts can't be the check, and with one physical count a year a shrinkage report would have one data point a year. What can go wrong in between is the software: a movement recorded without its batch change (or the reverse), or a Square payment that never became a `Sale` (a missed webhook, a failed job never replayed). The existing reconciliation report can't catch either: it sets `expectedQuantity = currentQuantity`, so every product reads reconciled, and nothing calls it (no web screen; the iOS app defines the endpoints but no screen uses them).

This epic deletes that report and adds a nightly integrity job in the worker: a books check (each product's batches add up to its movements) and a sales check (every Square payment of the day has its `Sale`). It is read-only: it logs, shows a banner in the web app, and never corrects stock or sales by itself.

Cost: one BullMQ job scheduler in the existing worker, a few grouped SQL queries and a few paginated Square calls per night — seconds of work and a few MB, no new service.

Alerts go to the Railway logs and a banner in the web app (decided 2026-10-27).

---

## Remove the reconciliation report

`GET /inventory/reconciliation/product/:productId` and `/location/:locationId` always answer "reconciled".

**Requirements**:
- Given the product and location reconciliation endpoints, should delete them with `reconcileProduct`, `reconcileLocation` and their types
- Given the FIFO checks in the same controller (`consumption/:productId`, `sale-item/:saleItemId`, `verify-fifo/:saleId`), should keep them working unchanged
- Given the iOS app, should note the two now-unused endpoint cases in `APIEndpoint.swift` for removal there

---

## Books check

For every product at every location, the stock in its batches must equal what its movements say.

Stock moves through `InventoryReceiving` (creates a batch), `InventoryAdjustment` (signed `quantity`; also transfers, break-bulk and the worker's `AUTO_SALE_COVER`), and `InventoryConsumption` (from a sale, or from a negative adjustment). Cutover opening batches and initial stock set at product creation have no movement record. `Inventory` keeps only the current `quantity`.

**Requirements**:
- Given a product at a location, should compute expected stock = opening stock + received + Σ adjustment quantities (signed) − sale consumption, and compare it to the sum of its batches' `quantity`
- Given consumption rows that belong to an adjustment, should leave them out (the adjustment already counts them)
- Given cutover opening batches and product-creation stock, should count them as opening stock, telling them apart from batches created by a receiving or a positive adjustment (add a batch source field if no existing link does)
- Given every product at every location, should run as a few grouped queries, never one query per product
- Given books that add up, should report no mismatch; given a product that doesn't, should report product, location, expected and actual

---

## Sales check

Every Square payment must have become a `Sale` (`Sale.squareId` is the Square payment id).

**Requirements**:
- Given a day and a location, should list that day's Square payments (paginated) and report each one with no `Sale` of the same `squareId`
- Given a payment whose sale job failed (e.g. `SaleValidationError` for a payment with no order), should report it as a failed job to replay, not as a lost sale
- Given a payment received after the check's cutoff (still in the queue), should not report it
- Given Square unreachable, should log that the check could not run and try again the next night, not retry in a loop

---

## Nightly integrity job

Run both checks every night in the worker and store the result for the web banner.

**Requirements**:
- Given the worker starting, should register one BullMQ job scheduler (`upsertJobScheduler`, idempotent across restarts and deploys) that runs the checks at 03:00 America/Mexico_City
- Given a run, should log one summary line (products checked, payments checked, mismatches) and one line per mismatch
- Given a run, should store its result (when it ran, counts, and each mismatch) so the api can read the latest one; keep only recent runs
- Given a run, should finish in seconds and a few MB, within the worker's memory budget

---

## Integrity banner in the web app

Show the owner the latest run's problems where they will see them.

**Requirements**:
- Given the latest run, should expose it through an owner-only api endpoint (non-owners get 403)
- Given an owner opening the web app after a run with mismatches, should show a banner naming how many products don't add up and how many payments have no sale, linking to the details
- Given a run with no mismatches, should show no banner
- Given no run in the last 2 days (the job stopped), should show a banner saying the check hasn't run, so a silent failure is visible too
- Given the banner, should follow the web app's existing alert styling (`ErrorBanner` / warning tokens)
