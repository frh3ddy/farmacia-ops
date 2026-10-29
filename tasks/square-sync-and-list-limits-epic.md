# Square Sync Lookup and List Limits Epic

**Status**: ✅ COMPLETED (2026-10-29)
**Goal**: Stock changes reach Square under the product's real Square item, and inventory lists and reports stay bounded as data grows.

## Overview

A product can carry a placeholder mapping (`local_<productId>`, written when a product or a location's price is set without a Square item) next to its real one, and every inventory sync to Square takes whichever mapping comes first, so a sync can send Square an id it doesn't know and fail for no visible reason. That lookup is copied in the adjustment, receiving and transfer services and in the worker's return sync, so it can only be fixed by fixing it everywhere. Separately, several inventory lists have no limit and the COGS report with no dates loads every sale. Found in the 2026-10-29 review of `apps/api/src/inventory/` (findings 4–7).

---

## ✅ One Square item lookup for stock syncs

Every stock sync to Square finds the product's Square item the same way.

**Requirements**:
- Given a product with a `local_` placeholder mapping and a real one, should sync under the real Square item
- Given a product with a mapping for the location and a global one, should prefer the location's
- Given a product whose only real mapping is tagged with another location (the catalog sync tags it), should still use it — Square items are the same at every location
- Given a product with only a `local_` placeholder, should record "Product not mapped to Square catalog" without calling Square
- Given the adjustment, receiving and transfer syncs, should share one lookup in `square-sync.ts`, and the worker's return sync should apply the same rule

---

## ✅ One way to save a receiving's sync result

Receiving saves its Square result through one method, as adjustments do.

**Requirements**:
- Given a receiving synced on create or on retry, should record the result through a single `recordSquareSync`

---

## ✅ Bounded inventory lists

Lists and the COGS report return a bounded amount of data.

**Requirements**:
- Given the transfers list, adjustments by product or receivings by product, should return at most `listLimit` rows, newest first
- Given a transfers list filtered by a status that doesn't exist, should answer 400 instead of 500
- Given the COGS report with no dates, should cover the current business month, as the dashboard does

---

## ✅ One list limit rule

Adjustments by location use `listLimit` like every other list.

**Requirements**:
- Given a limit that is missing, zero, negative or above the cap, should apply the same default and cap as receivings and expenses

---
