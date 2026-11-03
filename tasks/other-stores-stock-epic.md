# Other Stores' Stock Epic

**Status**: ✅ COMPLETED (2026-11-03)
**Goal**: any staff member sees how many units every store has of a product, without switching stores

## Overview

Staff at the counter or at receiving can't tell whether another store has a product: the existing reads are per store and a non-owner gets a 403 for any other store, and the owner has to switch stores to look. Knowing the other stores' counts lets staff ask for a transfer when their own store is at 0, and split a delivery between stores while receiving. The cutover endpoint `stock-by-location` isn't reusable — it reads Square's counts, which stopped being the truth after cutover. The phone (farmacia-ios `tasks/other-stores-stock-epic.md`) fetches this when a product or receiving line is opened, not through the delta sync, because a sale at one store would otherwise have to re-stamp that product for every store.

---

## Vision Exception

Record that every store's stock quantity is visible to all staff, as the one exception to "non-owners only see their own location's data".

**Requirements**:
- Given `vision.md`'s least-access rule, should name stock quantities (no cost, no price) as readable across stores by every role

---

## Stock by Store Endpoint

`GET /products/:id/stock` returns each store's on-hand quantity from the app's own batches.

**Requirements**:
- Given a product, should sum its batch quantities per active store from the app's records, never Square's counts
- Given a cashier or manager, should return every store's quantity, not just their own, and no LocationGuard 403
- Given any role, should return only store id, store name and quantity, never cost or price
- Given a store that sells the product but has no batches, should list it with 0 so "nobody has it" is visible
- Given a product sold at one store only, should list only that store
- Given a Yastás service product (no stock tracked), should list no stores
- Given an unknown product id, should return 404

---
