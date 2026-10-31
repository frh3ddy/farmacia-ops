# Cutover Migration Safety Epic

**Status**: ✅ COMPLETED (2026-10-30)
**Goal**: Each store's one-time migration gives every reviewed product its opening stock exactly once, survives a failure or a repeated call, deletes only what was marked no longer for sale, and starts from that store's finished extraction session.

## Overview

From the 2026-10-30 review of `apps/api/src/inventory-migration/`, before the production migration. Production state (checked by the owner): no cutover, lock or opening balance yet; extraction finished for Lolita (`310a854d…`, 3,391 approved / 715 skipped) and Oriente (`4c529f49…`, COMPLETED 2026-10-29, 3,350 / 756); 700+ products marked no longer for sale. The extracted data needs no repair; the migration run does.

A run works in batches (50 in the wizard) by position in a list it rebuilds on every call, while deleting discontinued products (and so their mappings) in the background between batches: the list shrinks under the cursor and later products get no opening stock, and an added mapping repeats one. A failed batch marks the cutover FAILED, which `continue` refuses, and starting again creates a new cutover from batch 0 that inserts every finished batch again. Two calls at once insert one batch twice. Deleting a discontinued product deletes its whole Square item, so sibling variations still for sale vanish from Square. Products left without stock don't stop the lock. Any manager can start a cutover. The wizard can't open a completed session, so a store can only migrate from a new session that copies decisions (latest approved cost from any store).

The migration is one time only; a store added later gets its costs at product creation and never migrates.

---

## ✅ Each item migrated exactly once

**Requirements**:
- Given a batch, should take the store's next items that have no opening balance from this cutover yet, not a position in the list
- Given products deleted or mappings added during the run, should neither skip nor repeat an item
- Given two calls for one cutover at once, should insert each item's opening balance once (the second waits or is refused)

---

## ✅ A failed run resumes

**Requirements**:
- Given a cutover that failed mid-run, should continue from the items still without opening stock
- Given a new start for a store and session that already has an unfinished cutover, should continue that cutover instead of creating another

---

## ✅ Discontinued products deleted safely

**Requirements**:
- Given products marked no longer for sale, should delete them after the last batch, not between batches
- Given a discontinued product whose Square item has variations still for sale, should delete only its variation; the whole item only when every variation on it is discontinued
- Given a Square failure, should keep the product (as today) and report it in the run's result

---

## ✅ No lock with products left out

**Requirements**:
- Given products that got no opening stock (missing cost, product not found), should list them by name and not lock the store until there are none or the owner confirms
- Given a cost that fails to compute, should report why instead of swallowing the error

---

## ✅ Owner only, from the finished session

**Requirements**:
- Given anyone but the owner, should refuse to start or continue a cutover
- Given the wizard, should list a store's completed sessions with a way to migrate from one, using the costs approved in that session

---

## ✅ Tests

**Requirements**:
- Given a real multi-batch migration (PGlite), should cover: a discontinued product deleted mid-run, an added mapping, a failure then resume, a second start reusing the cutover, two calls at once, an item with a discontinued and a kept variation, a product left without cost blocking the lock, and the owner-only check

---

Done: the cutover's `batchState` keeps the items done (`locationId:variationId`) and those left out, written in the batch's transaction; each batch first claims `currentBatch` (a second call waits, then inserts nothing); opening batches carry `migrationId`. A start for a session with an unfinished cutover continues it; `continue` accepts a FAILED one. `finishCutover` stops with `needsConfirmation` and `leftOut` until `continue` gets `confirmLeftOut`, then retires discontinued products (`ProductsService.retireVariations`, which replaces `deleteCatalogItem`) and locks. The wizard's session list shows finished sessions with "Migrar", and the report lists products left out with "Bloquear la sucursal sin estos productos". Tests: `cutover-migration.pg.spec.ts`, `retire-variations.spec.ts`, `cutover-migration.test.tsx`.

## Go-live runbook (no code)

1. Deploy this epic; confirm no cutover exists (`Cutover`, `CutoverLock`, `OPENING_BALANCE` counts 0).
2. After closing, one night: migrate Lolita from session `310a854d…`, then Oriente from `4c529f49…`.
3. Right away: enable the Square webhook subscription and set `SALES_RECORDING_STARTED_AT`.
4. Set each store's Yastás wallet balance (Yastás screen) before the first Yastás sale.
5. The cutover date is sent as midnight UTC (6 pm the day before in Mexico City); pick the date with that in mind.
