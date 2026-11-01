# Sales Only After Cutover Epic

**Status**: ✅ COMPLETED (2026-10-31)
**Goal**: A Square sale is only recorded at a store that has finished its cutover, and never for stock the opening count already reflects

## Overview

The worker records a Square sale at any store. At a store that hasn't finished its cutover there is no stock, so every sale creates a cover batch at the last known cost and costs the sale against it. A payment from a Square location the app doesn't know even creates a placeholder store. Only the go-live order (migrate both stores, then turn on the webhook) prevents this, so a failed migration on go-live night would cost that store's sales against nothing. Refusing the sale fails the job, and failed sale jobs are kept 30 days for replay, so the sale waits until the store is cut over. A sale dated on or before the cutover already left the shelf before the opening count, so recording it on replay would take that stock out twice. The nightly sales check already expects sales only after each store's cutover.

---

## Refuse Sales Before Cutover

Check the store and its cutover before recording an order's sale, Yastás lines or custom amounts.

**Requirements**:
- Given a payment at a store with no cutover, should fail the job and record nothing (no sale, stock, cover batch or Yastás operation), so it can be replayed
- Given a payment from a Square location the app doesn't know, should fail the job without creating a store
- Given a payment dated on or before the store's cutover, should record nothing and finish the job, since the opening count already reflects it
- Given a payment after the store's cutover, should record the sale as before
- Given a cutover that covers every store (a lock with no store), should count as each store's cutover

---
