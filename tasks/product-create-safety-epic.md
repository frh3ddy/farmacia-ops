# Product Create Safety Epic

**Status**: ✅ COMPLETED (2026-10-29)
**Goal**: Creating a product either succeeds completely or leaves nothing behind, in the app or in Square, and initial stock respects the cutover.

## Overview

`createProduct` creates the Square item first, then writes the product, mapping, stock batch and supplier cost as separate writes, so any later failure leaves an orphan Square item, and a client retry creates a second one because the Square call uses a random idempotency key. The controller creates laboratories, active ingredients and medication definitions before anything is validated. Initial stock is written as an `OPENING_BALANCE` batch and pushed to Square with no cutover check; the cutover then skips that location's batch for the product because one already exists, so it never takes Square's count and the stock stays at the number entered at creation. Found in the 2026-10-29 review of `apps/api/src/products/` (findings 4–5).

---

## ✅ Initial stock respects the cutover

**Requirements**:
- Given initial stock for a location that hasn't finished its cutover, should refuse it with a Spanish message (`assertCutOver`) before creating anything
- Given a location that has finished its cutover, should record the initial stock as today
- Given initial stock with no cost price, should answer 400 instead of silently creating no stock

---

## ✅ Validate before writing

**Requirements**:
- Given a `costPrice` that isn't a finite number of 0 or more, or an `initialStock` or loose `quantity` that isn't a whole number of 0 or more, should answer 400 before calling Square or the database
- Given `medication` without an `activeIngredients` array, should answer 400 instead of 500
- Given a rejected request, should create no laboratory, active ingredient or medication definition
- Given a SKU with surrounding spaces, should check uniqueness and send Square the trimmed SKU, as the database stores it

---

## ✅ All or nothing

**Requirements**:
- Given the product, mapping, stock batch and supplier cost, should write them in one transaction
- Given a database failure after the Square item was created, should delete that Square item, or record it so a retry reuses it
- Given a retried create from the client (same `clientRequestId`), should answer with the existing product before calling Square, instead of creating a second item (the `clientRequestId` becomes the product's id; each attempt that reaches Square uses a fresh key, since a failed attempt's item is deleted)
- Given a successful create, should report the resolved name in the success message

---

## ✅ Tests

**Requirements**:
- Given each case above, should be covered by a test of `createProduct` (PGlite for the database, a recorded fake Square client)

---
