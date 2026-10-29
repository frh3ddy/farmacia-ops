# Product Price Sync Epic

**Status**: ✅ COMPLETED (2026-10-29)
**Goal**: A price change in the app changes only the price in Square, either for every location or for one, and never creates a second Square item for a product.

## Overview

A price update for one location sets the variation's `presentAtLocationIds` to that location alone, so the item disappears from every other store's register while its base price still changes everywhere. "Apply to all locations" sets `presentAtAllLocations`, which switches the item back on at stores where it was deliberately turned off, and any MANAGER can use it. Separately, the products code finds a product's Square item by trying the location's mapping, then the global one, in four places; a product whose only real mapping is tagged with another location gets a `local_` placeholder on a price update, and the next sync creates a duplicate Square item for it. Found in the 2026-10-29 review of `apps/api/src/products/` (findings 1–3 and 6). The owner decided that most price changes apply to every location, and that some locations sometimes need their own price.

---

## ✅ Price changes leave availability alone

A price update changes the price and nothing about where the item is sold.

**Requirements**:
- Given a price for all locations, should set the variation's base `priceMoney` and drop any location override, without changing `presentAtAllLocations`, `presentAtLocationIds` or `absentAtLocationIds`
- Given a price for one location, should set or replace that location's entry in `itemVariationData.locationOverrides` (`locationId`, `priceMoney`, `pricingType: FIXED_PRICING`), keep the other locations' overrides, and leave the base price alone
- Given either kind of update, should keep every other field of the variation as Square returned it, and send the variation's current `version`
- Given the location-enablement-mismatch error handler, should remove it once no update narrows the variation's locations
- Given an all-locations price, should update the cached `priceCents` on every mapping for the product; given a one-location price, should update only that location's mapping

---

## ✅ Only the owner changes every location's price

**Requirements**:
- Given a MANAGER sending `applyToAllLocations: true`, should answer 403 with a Spanish message and change nothing
- Given a MANAGER, should set the price only for their own location
- Given an OWNER, should allow either an all-locations or a one-location price

---

## ✅ One Square item lookup for products

Every product read and price update finds the product's Square item the same way the stock syncs do.

**Requirements**:
- Given a product whose only real mapping is tagged with another location, should use that Square item and not write a `local_` placeholder
- Given a product with a real mapping, should never create another Square item for it, from a price update or from `syncUnsyncedProducts`
- Given the product list, product detail, price update and dashboard counts, should share one rule: the location's real mapping, then the global one, then any real mapping, and never a `local_` placeholder while a real mapping exists (reuse `findSquareVariationId` from `square-sync.ts`)
- Given the dashboard counts, should not count a product with a real mapping on another location as "local, pending sync"

---

## ✅ Tests on what goes to Square

**Requirements**:
- Given each case above, should assert the exact payload sent to the Square catalog (a recorded fake client), as `labor.service.spec.ts` does

---
