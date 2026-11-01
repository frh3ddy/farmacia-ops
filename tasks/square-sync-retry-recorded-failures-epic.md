# Square-Sync Retry Only for Recorded Failures Epic

**Status**: ✅ COMPLETED (2026-10-31) — `717df0f`
**Goal**: The owner's adjustment and receiving Square-sync retries resend only a record whose sync failed and was recorded, as transfers already do

## Overview

`POST /inventory/adjustments/:id/retry-square-sync` (OWNER) is called by the iOS app's retry button in product activity and global history. The app only offers it for a recorded failure (`squareSynced` false with a `squareSyncError`), but the API resent any adjustment not marked synced, including one created with `syncToSquare: false` or sent before results were recorded, which may already be in Square. Count correction and break-bulk also used the retry for their first send after their transaction committed.

---

## Retry Only a Recorded Failure

**Requirements**:
- Given a retry of an adjustment with no recorded Square failure, should refuse it (400, "Este ajuste no tiene un envío fallido a Square que reintentar") without calling Square
- Given a recorded failure, should resend with the same idempotency key and record the result (unchanged)
- Given an adjustment already synced, should report it synced without calling Square (unchanged)
- Given a transfer leg, should refuse the retry (unchanged)

## First Send After a Transaction

Count correction and break-bulk send their committed adjustments with `syncCommitted(id)`, not the retry, so the new guard doesn't block them.

**Requirements**:
- Given a count correction or a break-bulk with `syncToSquare`, should still send to Square after commit

## Receiving Retry

`POST /inventory/receive/:id/retry-square-sync` (OWNER, also called by the iOS retry button) had the same gap. Nothing else uses it for a first send (receiving sends inline after its transaction).

**Requirements**:
- Given a retry of a receipt with no recorded Square failure, should refuse it (400, "Esta recepción no tiene un envío fallido a Square que reintentar") without calling Square
- Given a receipt Square rejected, then retried, should record the failure then the success, keyed on the receiving (unchanged)
