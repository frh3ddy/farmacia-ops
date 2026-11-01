# Counted Correction Lock Epic

**Status**: ✅ COMPLETED (2026-10-31)
**Goal**: A stock count entered while sales are coming in leaves the shelf total equal to the count, minus only the sales recorded after it

## Overview

A counted correction ("I counted N") reads the stock on hand, then writes the difference as an adjustment. The read isn't locked, so a sale the worker records in that gap is counted twice: once in the stock the read saw, and again when the sale decrements it. The result is off by that sale's quantity. Nothing sells in production until go-live, so this hasn't happened yet, but counts during opening hours will hit it once sales are recorded. The worker and negative adjustments already decrement each batch atomically. Only the counted-correction read needs fixing.

---

## Lock Stock During a Count

Read the on-hand stock and write the correction in one transaction, locking the product's batches at that store (`SELECT … FOR UPDATE`) so a sale waits until the count is applied.

**Requirements**:
- Given a sale recorded while a count is being applied, should leave stock equal to the count minus that sale
- Given a count that matches the stock on hand, should still refuse it as nothing to adjust
- Given a count at a store with no stock of the product, should add the counted quantity as before
- Given a replayed count (same `clientRequestId`), should return the first result without adjusting again
- Given a count of one product, should not hold up sales of other products or of the same product at other stores

---
