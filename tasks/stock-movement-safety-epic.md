# Stock Movement Safety Epic

**Status**: ✅ COMPLETED (2026-10-29)
**Goal**: A transfer or break-bulk either moves all its stock or none, and a transfer that didn't reach Square can be sent again.

## Overview

Shipping a transfer and breaking bulk each commit their first leg before the second, so a failure in between takes stock out of a location without putting it anywhere: inventory value drops and the nightly books check can't explain it. A malformed `quantity` (a string) is enough to cause it on a transfer. Separately, a received transfer's Square sync result is thrown away, and the transfer can't be received twice, so a failed sync leaves Square's counts wrong for good. Found in the 2026-10-29 review of `apps/api/src/inventory/`.

---

## ✅ Validate movement quantities up front

Reject a bad transfer or box quantity before any stock moves.

**Requirements**:
- Given a transfer `quantity` or break-bulk `boxQuantity` that isn't a positive whole number (a string, a fraction, `true`), should answer 400 in Spanish and leave every batch unchanged

---

## ✅ Ship a transfer in one transaction

The origin's `TRANSFER_OUT` and the `Transfer` record commit together.

**Requirements**:
- Given `createAdjustment` called with a caller's transaction, should consume FIFO inside it and leave the Square sync to the caller after the commit
- Given creating the `Transfer` fails after the origin's batches were consumed, should roll the consumption back so the origin's stock and value are unchanged

---

## ✅ Break bulk in one transaction

The box leg and the loose leg commit together; Square hears about both only after.

**Requirements**:
- Given the loose leg fails, should roll back the box leg so the box product's stock is unchanged
- Given `syncToSquare`, should sync both legs after the commit, each recording its own result on its adjustment

---

## ✅ Record and retry a transfer's Square sync

Keep a received transfer's Square result and let the owner send it again.

**Requirements**:
- Given a received transfer, should store whether Square took it and Square's error on the `Transfer` (migration adds `squareSynced`, `squareSyncedAt`, `squareSyncError`)
- Given an owner retrying a received transfer that didn't sync, should resend the received units and the shortfall under the transfer's idempotency key, and record the new result
- Given a retry on a transfer that already synced, one not yet received, or one never sent to Square (including those received before results were recorded), should not call Square
- Given the Transfers screen, should show a received transfer's Square error and, to the owner, a "Reintentar" button

---
