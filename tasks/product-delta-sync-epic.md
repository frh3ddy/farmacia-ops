# Product Delta Sync Epic

**Status**: ✅ COMPLETED (2026-11-02)
**Goal**: The phone asks for only the products that changed since its last sync, and can never be left holding stale stock, prices or products

## Overview

The iOS app re-walks the whole product list on every tab switch, though usually only a handful of products changed, and nothing can tell it which: Product and Inventory carry no change mark, and the commonest change, a sale taking stock off its FIFO batches, is a raw `UPDATE "Inventory"` that Prisma's `@updatedAt` would never stamp. A clock-time bookmark can also miss a change committed late by a long transaction, and an offset-paged walk can skip a row when the list shifts under it. So database triggers stamp each product with the id of the transaction that last changed it, its batches, its price links, its category or its store links, and keep a removal mark when a product is deleted; the sync pages by that stamp with a cursor whose floor is the oldest transaction still running, so a change is either already sent or sent next time. The stamp is one column overwritten in place and removals are rare, so nothing grows and no device needs tracking.

---

## Product Change Stamp

One migration adds `Product.changeXid`, a `ProductRemoval` mark, and the triggers that set them.

**Requirements**:
- Given a sale's raw FIFO update of a batch, should stamp that batch's product with the writing transaction's id
- Given a batch or price link inserted, updated or deleted, should stamp its product, and both products when a link moves from one to another
- Given a category or store renamed, should stamp every product the list shows it on
- Given a product deleted, should keep a removal mark with the deleting transaction's id
- Given a write to another product, should leave this one's stamp alone

---

## Sync Cursor

A pure cursor that says where a sync is and the oldest transaction it may not have seen.

**Requirements**:
- Given no cursor, should start from the beginning, so a full walk is the same call
- Given each page, should keep the lowest running-transaction floor seen across the whole walk
- Given the last page, should hand back a cursor that resumes from that floor, so a transaction still running during the walk is sent next time
- Given a cursor that isn't one, should refuse it in Spanish

---

## Product Sync Endpoint

`GET /products/sync?locationId=&cursor=` pages products and removals in stamp order, in the list's row shape.

**Requirements**:
- Given a cursor, should return only products and removals stamped after it, in stamp order, so no row is skipped while the list changes
- Given a product changed or added mid-walk, should still send it in this walk or the next
- Given a product deleted, or now sold only at another store, should report it as removed for this store
- Given a cashier, should strip costs as the list does
- Given one transaction stamping more products than a page, should page through all of them
