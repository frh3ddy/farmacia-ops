# Products Review Follow-ups Epic

**Status**: ✅ COMPLETED (2026-10-29)
**Goal**: Fix what the second products review found in the new code, and let a product be sold at one store only.

## Overview

The second review of `apps/api/src/products/` (2026-10-29) found that the new loose-link loop check can follow a loop already in the data forever, that an all-stores price change on a Yastás product skips its mappings (they all carry an `employeeId`) and adds a stray one, though Yastás products have no set price at all, and that `createProductInSquare` ignores the location it is given. The owner clarified that some products, such as a single toy, should be sold at one store only, with a switch that defaults to every store. Products created in the web back office reach Square later (through "sync to Square" or their first price change), so the choice is saved on the product. Also small cleanup: creating a product validates twice, the controller repeats the service's checks, and two spots are loosely typed or worded.

---

## ✅ Loose-link check stops on existing loops

**Requirements**:
- Given a loose product whose chain already loops without reaching this product (B→C→B), should answer, not loop forever: stop at the first product seen twice
- Given a chain that leads back to this product, should still answer 400

---

## ✅ No price changes for Yastás products

Yastás products have no set price: their revenue is entered by hand on the Yastás screen.

**Requirements**:
- Given a price change for a Yastás product (its mappings carry an `employeeId`), should answer 400 with a Spanish message and change nothing, in Square or the database
- Given the all-stores price update, should drop the `employeeId: null` filter, which only existed for Yastás mappings

---

## ✅ Sell at one store or every store

A switch on product creation, on by default: sell at every store. Off: sell only at the store creating it.

**Requirements**:
- Given a new product, should save whether it is sold at every store (default) or only at its store, on the product (migration with default `true`, so existing products keep selling everywhere)
- Given a product sold everywhere, should create its Square item as today, present at all locations
- Given a product sold at one store, should create the Square item and its variation both present only at that store's Square location, so the variation never reaches further than its item
- Given a product sold at one store, should apply the same rule when it first reaches Square later, from "sync to Square" or its first price change
- Given a product sold at one store whose store has no Square location, should not create it in Square and should say why (Spanish)
- Given `createProductInSquare`, should take the product's choice instead of the unused `locationId` parameter
- Given the web back office's new-product form, should show the switch, on by default ("Vender en todas las sucursales")

---

## ✅ One validation pass on create

**Requirements**:
- Given a create, should validate once: the service checks the input, then finds or creates the laboratory and medication definition itself, so the controller passes `labName` and `medication` through instead of resolving them first
- Given the controller, should drop its own name and price checks, which the service already makes
- Given `withoutCosts`, should be typed without `any`
- Given the `catalog-product-view.ts` docblock, should say plainly which mapping it reads

---

## ✅ Tests

**Requirements**:
- Given each case above, should be covered: the existing-loop walk, a refused Yastás price change, the Square payload for one-store and every-store products from all three create paths, and the single validation pass

---
