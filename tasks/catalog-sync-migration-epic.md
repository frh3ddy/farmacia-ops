# Catalog Sync Migration Epic

**Status**: ✅ COMPLETED (2026-10-30)
**Goal**: Catalog sync works only as the migration tool it is: owner-only, refused after cutover, never breaking Yastás, never bringing back archived items, and with its rough edges gone.

## Overview

From the 2026-10-30 review of `apps/api/src/catalog/`. The owner said catalog sync is for the migration and should not be used once the migration and cutover are done. Products made after that are created in the app, which creates their Square item and mapping itself. Today any manager can run it for any store or for every store, at any time. A sync for one store creates that store's own mapping for a Yastás item without its employee, and the worker prefers it, so every Yastás line at that store fails the sale. Archived Square items come back as products, although the migration deletes items no longer for sale (`finalizeDiscontinuedProductDeletion`). Smaller: errors are 500s with raw English messages, two naming rules disagree, the SKU-clash recovery runs inside an aborted transaction, and there's dead code. Concurrent syncs, per-store prices, one-store Square items and the request timeout are left out: the sync is short-lived, and they would show as duplicates or wrong prices before cutover.

---

## ✅ Refused after cutover

**Requirements**:
- Given a sync for a store whose cutover is done (its cutover lock), should answer 400 in Spanish and change nothing
- Given a sync with no store once any store's cutover is done, should answer 400 in Spanish
- Given stores not yet cut over, should sync as today

---

## ✅ Owner only

**Requirements**:
- Given a manager or anyone but the owner, should answer 403
- Given a `locationId` that doesn't exist, should answer 400 in Spanish, not 500

---

## ✅ Yastás items keep their employee

**Requirements**:
- Given a sync for a store and a variation whose mapping carries an employee (a Yastás item), should not create a store mapping without that employee, so the worker keeps using the employee's mapping
- Given a forced resync of a Yastás mapping, should keep its employee

---

## ✅ Archived Square items skipped

**Requirements**:
- Given a Square variation or its item archived (or no longer present), should neither create a product nor a mapping for it, and count it as skipped

---

## ✅ Small fixes and cleanup

**Requirements**:
- Given a sync failure, should answer in Spanish without raw database messages
- Given Square's missing-item fallback name, should be one the placeholder rule recognizes (repaired later), and a variation named like "Regular 500 ml" should keep its name (one exact placeholder rule, shared)
- Given two variations with one SKU created at once, should recover outside the failed transaction instead of always failing
- Given the snake_case fallbacks SDK 46 never returns, the double price check, the no-op `locationId` on an existing mapping, the per-price debug logs and the noise comments, should be removed; the Square objects typed instead of `any`
- Given the stale-data check, should not fetch from Square variations it is about to skip

---

## ✅ Tests

**Requirements**:
- Given each case above, should be covered in Riteway: refusal after cutover (store and every store), owner-only, a store sync next to a Yastás mapping, an archived item, Spanish errors, the naming rule and the SKU clash
