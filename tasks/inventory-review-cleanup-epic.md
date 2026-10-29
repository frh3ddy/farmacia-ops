# Inventory Review Cleanup Epic

**Status**: ✅ COMPLETED (2026-10-29)
**Goal**: Close the small leftovers from the 2026-10-29 inventory review: a price that isn't a number, replay checks that disagree, a receipt check in the wrong place, and comments that repeat the code.

## Overview

A selling price that isn't a number (sent with a receiving or from the products screen) gets past `updatePrice`, which only rejects negatives, and can reach the catalog and Square. Adjustments and receivings recognise an offline replay differently: one checks the replay before validating, the other after, and receiving ignores the unit cost when deciding a replay is the same request. A transfer receipt over the shipped quantity is caught only after the transfer is claimed. And many inventory comments only restate the next line. Finding 8 of the review; its stale `batchCreateChanges` comment was already removed with the code it described.

---

## ✅ Validate selling prices

`ProductsService.updatePrice` refuses a price that isn't a number, for every caller.

**Requirements**:
- Given a selling price that is a string, `NaN` or infinite, when creating a product or updating its price, should answer 400 in Spanish and change no price, locally or in Square
- Given a receiving sent with such a price, should still record the receiving and report the price as not updated

---

## ✅ Consistent replay checks

Adjustments and receivings recognise a replay the same way.

**Requirements**:
- Given an adjustment, should validate its input before looking for a replay, as receivings do
- Given a receiving replay with a different unit cost, should answer 409 as for any other changed field

---

## ✅ Check transfer receipts before claiming

Every line receipt is checked before the transfer is marked received.

**Requirements**:
- Given a line receipt above the quantity shipped, should answer 400 before the transaction starts, with the transfer still in transit

---

## ✅ Comments that say why

Inventory comments explain intent, not the next line.

**Requirements**:
- Given a comment in `apps/api/src/inventory/` that only restates the code below it (`// Get location`, `// Check product exists`, `// Execute in transaction`), should remove it, keeping every comment that explains a reason

---
