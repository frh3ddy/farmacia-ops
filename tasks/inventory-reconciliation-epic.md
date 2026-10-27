# Inventory Reconciliation Epic

**Status**: 📋 PLANNED
**Goal**: The reconciliation report shows a real discrepancy, so stock that doesn't add up gets noticed instead of always reading "reconciled".

## Overview

`InventoryReconciliationService.reconcileProduct` (`apps/api/src/inventory/inventory-reconciliation.service.ts`) never computes an expected quantity: it sets `expectedQuantity = currentQuantity`, so `discrepancy` is always 0 and every product and location reports `isReconciled: true`. `openingBalance` is rebuilt as current + consumed, and `totalReceived` is hard-coded to 0. The vision's goal that inventory operations "keep stock and cost true to the shelf" has no check behind it. Found while removing an unused `openingBalance` local (2026-10-26).

Stock enters and leaves a location's batches through:
- `InventoryReceiving` rows (each creates a batch);
- `InventoryAdjustment` rows with a signed `quantity`, which also cover transfers (`TRANSFER_OUT` / `TRANSFER_IN`), break-bulk (`BREAK_BULK_OUT` / `BREAK_BULK_IN`) and the worker's `AUTO_SALE_COVER` (`sale.worker.ts`);
- `InventoryConsumption` rows, from a sale (`saleItemId`) or from a negative adjustment (`adjustmentId`);
- batches with no movement record: cutover opening batches (`inventory-migration.service.ts`) and the initial stock set at product creation (`products.service.ts`).

Counting a negative adjustment both as an adjustment and as its consumption rows would subtract it twice, and counting a receiving both as a receiving and as its batch would add it twice.

**Open questions** (answer before execution):
- What should a discrepancy catch? Batch quantities change only through the movements above, so expected-from-movements equals current stock unless the software itself mis-records (a double consumption, a lost write). Shelf loss shows up only against a physical count (`COUNT_CORRECTION`). If shelf truth is the goal, this epic should become "compare to the last physical count" instead.
- Does any screen use the report today? The api exposes `/inventory/reconciliation/product/:productId` and `/location/:locationId`, the iOS app has them in `APIEndpoint.swift`, and the web app has no caller.
- Should the expected quantity cover all time, or a period starting at the location's cutover date?
- How is an opening batch told apart from a batch created by a receiving or a positive adjustment? `Inventory` may need a source field, or a link from the movement to the batch it created.

---

## Expected quantity from movements

Compute what a product's stock at a location should be, from its recorded movements.

**Requirements**:
- Given a product's batches and movements at a location, should compute expected = opening stock + received + Σ adjustment quantities (signed) − sale consumption
- Given batches created at cutover or with product creation, should count their starting quantity as opening stock (`Inventory` keeps only the current `quantity`, so a batch's start is its current quantity plus everything consumed from it)
- Given consumption rows that belong to an adjustment, should leave them out (the adjustment already counts them)
- Given a batch created by a receiving or a positive adjustment, should count it once, as that movement
- Given a movement from another location or product, should leave it out

---

## Real discrepancy

Report the gap between the batches' current quantity and the expected quantity.

**Requirements**:
- Given current stock that matches the expected quantity, should report `discrepancy` 0 and `isReconciled: true`
- Given current stock that differs from the expected quantity, should report the difference (current − expected) and `isReconciled: false`
- Given a product with no batches or movements, should report it reconciled with zeros
- Given the result, should fill `openingBalance`, `totalReceived` and `totalConsumed` from the same movements the expected quantity used (no placeholders)

---

## Location roll-up

`reconcileLocation` summarizes its products from `reconcileProduct`.

**Requirements**:
- Given a location with one product off by some units, should count that product as unreconciled and the others as reconciled
- Given the location report, should keep the existing response shape so the iOS app's endpoints keep working
