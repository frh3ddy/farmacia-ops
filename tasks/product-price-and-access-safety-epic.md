# Product Price and Access Safety Epic

**Status**: ✅ COMPLETED (2026-10-29)
**Goal**: A price change either reaches Square or changes nothing, staff act only with the role they hold at that store, and bad product input gets a 400, never a 500.

## Overview

From the third review of `apps/api/src/products/` (2026-10-29), findings 1–3. When Square rejects a price change, the app keeps the new price and answers success, and the iOS price editor never checks `squareSynced`, so staff see a price the register doesn't charge. `LocationGuard` lets an employee name any store they are assigned to, but the role checks use their role at the current store, so a manager at one store who is a cashier at another can create stock, sync, and read costs there; `getProduct` also returns every store's receivings. Product creation doesn't check reference ids, fixed-value fields or true/false fields, so a bad value fails inside the save as a 500, after a Square item was created and deleted. The owner decided a failed Square price change is refused.

---

## ✅ A failed Square price change changes nothing

**Requirements**:
- Given a price change Square rejects or doesn't answer (product in Square, or a local product being created in Square by its first price), should answer 502 with a Spanish message and leave every cached price as it was
- Given a one-store price at a store with no Square location, or `syncToSquare: false`, should save the price in the app only, as today, and say so in Spanish
- Given a successful price change, should answer with Spanish messages

---

## ✅ The role at the store being acted on

**Requirements**:
- Given a non-owner creating a product or running "sync to Square" for a store other than their current one, should answer 403 (as price changes already do)
- Given a product read for a store, should hide costs by the reader's role at that store, not at their current one
- Given a product's recent receivings, should show only the requested store's, as its stock and average cost already are (an owner's every-store read, with no store, still shows all)

---

## ✅ Product input checked before saving

**Requirements**:
- Given `categoryId`, `labId`, `medicationDefinitionId` or `looseProductId` that doesn't exist, should answer 400 before creating anything
- Given `medicationType`, `primaryPackaging`, `secondaryPackaging`, `medication.form` or `medication.route` outside their fixed values, should answer 400
- Given `requiresPrescription`, `isControlled`, `syncToSquare` or the one-store choice that isn't true/false, should answer 400
- Given an active ingredient without a name, should answer 400
- Given any of these, should leave no laboratory, ingredient or medication definition behind and never call Square

---

## ✅ Tests

**Requirements**:
- Given each case above, should be covered: a Square failure on price changes (product in Square and first price), a manager who is a cashier at the requested store, and each kind of bad create input

---
