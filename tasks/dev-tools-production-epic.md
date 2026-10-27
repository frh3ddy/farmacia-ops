# Dev Tools in Production Epic

**Status**: ✅ COMPLETED
**Goal**: Tools meant for testing and fresh starts can't change real stock, cost or sales once the app is the source of truth.

## Overview

Found while hardening the worker (tasks/worker-hardening-epic.md, which already blocks test sales in production). Three more owner-only endpoints in `apps/api/src/data/data.controller.ts` write or delete production data with no environment check:

- `POST /api/inventory/test` (Dev Tools → Test Inventory) creates 100-unit batches at $5 for the given products **plus 3 arbitrary products**, at a hard-coded Square location `L60AMVPDZJ48F` (created as "Test Location" if missing). The batches have no receiving or adjustment, so the nightly books check treats them as opening stock and can't flag them.
- `POST /api/catalog/cleanup` (Catalog Sync screen, typed "DELETE" confirm) deletes every product, mapping, batch, receiving, consumption and sale.
- `POST /api/wipe/full` (no screen; body must say "DELETE EVERYTHING") deletes all data including employees.

Production is `RAILWAY_ENVIRONMENT_NAME=production`. Decision (owner, 2026-10-27): block all three in production; staging and local keep them.

**Done**: `NotInProduction` moved to `apps/api/src/auth/guards/not-in-production.guard.ts` and applied to test sales, test inventory, catalog cleanup and full wipe (spec: `not-in-production.spec.ts`). The screens show the api's 403 message, so no web change was needed.

---

## Block test inventory in production

**Requirements**:
- Given the production environment, should refuse `POST /api/inventory/test` and say why
- Given the Test Inventory screen in production, should show that reason (the screen displays api errors)
- Given staging or a local run, should keep creating test inventory as today
- Given production, should list any batches test inventory already created (100 units at $5.00, no receiving or adjustment, or at the location with Square id `L60AMVPDZJ48F`) for the owner to decide on — no automatic deletion

---

## Share the production block

**Requirements**:
- Given `NotInProduction`, should live with the auth guards so the webhooks and data controllers both use it, not one importing the other's controller

---

## Block the destructive resets

Catalog cleanup and full wipe made sense before cutover; after it they erase the only record of stock and cost.

**Requirements**:
- Given the production environment, should refuse catalog cleanup and full wipe
- Given the Catalog Sync screen in production, should show the reason (it displays api errors)

---

## Existing test batches in production

Run by the owner (read-only); decide per row, nothing is deleted automatically. `L60AMVPDZJ48F` is the real Oriente store, so the query matches test batches by their markers, not by location:

```sql
select i.id, p.name, l.name as location, i.quantity, i."unitCost", i."receivedAt"::date
from "Inventory" i
join "Product" p on p.id = i."productId"
join "Location" l on l.id = i."locationId"
where i."unitCost" = 5 and i.source is null and i."migrationId" is null
  and not exists (select 1 from "InventoryReceiving" r where r."inventoryBatchId" = i.id)
  and not exists (select 1 from "InventoryAdjustment" a where a."createdBatchId" = i.id)
  and not exists (select 1 from "TransferLine" t where t."destinationInventoryId" = i.id)
order by i."receivedAt";
```
