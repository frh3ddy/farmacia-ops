# Product Lists and Square Cleanup Epic

**Status**: ✅ COMPLETED (2026-10-29)
**Goal**: Product lists show each store only what it sells, stay fast for any search, and the remaining Square and typing rough edges are gone.

## Overview

From the third review of `apps/api/src/products/` (2026-10-29), findings 4–9. Catalog search has no result limit and looks up equivalents once per result. A product sold at one store shows at every store (list, search, dashboard), which the owner decided to hide; that needs the store it belongs to, which the true/false `soldAtAllLocations` doesn't record. The dashboard counts Yastás and discontinued products as out of stock. Renaming an item in Square rebuilds it from a few fields and drops the rest. Smaller: a simultaneous retried create gets a 500, "sync to Square" can create a $0 item, search wildcards aren't escaped, and some `any` types, a duplicate check, a stale comment and a misplaced import remain.

---

## ✅ The store a one-store product belongs to

**Requirements**:
- Given a product sold at one store, should record that store (`Product.soldOnlyAtLocationId`, null = every store) instead of the true/false `soldAtAllLocations`; the `20261030120000` migration has never been deployed, so rewrite it rather than stack a second one (confirm no local database applied it first)
- Given the create body, the web switch and the three paths into Square, should keep working as today, reading the store from the product

---

## ✅ One-store products only at their store

**Requirements**:
- Given another store's product list, catalog search, equivalents or dashboard counts, should leave out a product sold only at a different store
- Given its own store, or the owner's every-store view, should show it as today
- Given a direct read by id, should still return it

---

## ✅ Bounded catalog search

**Requirements**:
- Given any query, should return at most a fixed number of results, as the product list's search does (500)
- Given results with medication definitions, should load their equivalents together, not one query per result

---

## ✅ Dashboard counts only stocked merchandise

**Requirements**:
- Given Yastás products (no inventory) and discontinued products, should leave them out of the counts

---

## ✅ Renaming keeps the whole item

**Requirements**:
- Given a rename in Square, should send back the item as Square returned it with only the name changed, as price changes do, and fix the docblock that says otherwise

---

## ✅ Small fixes and cleanup

**Requirements**:
- Given two simultaneous creates with one `clientRequestId`, should answer the second with the existing product, not a 500
- Given "sync to Square" for a placeholder with no stored price, should skip it with a Spanish reason instead of creating a $0 item
- Given `%` or `_` in a search, should match them literally
- Given `ProductResult.product`, `PriceUpdateResult.product` and the remaining `as any` in the products Square calls and image filter, should be typed
- Given the price route, should drop its own "price required" check, which `assertSellingPrice` already makes
- Given `includeBlock`'s comment, should be accurate, and `stripAccents` should be imported from a shared module, not `inventory-migration`

---

## ✅ Tests

**Requirements**:
- Given each case above, should be covered: one-store visibility per store and for the owner, the search cap, counts without Yastás and discontinued, the rename payload, the concurrent retry, the $0 skip and literal wildcards

---
