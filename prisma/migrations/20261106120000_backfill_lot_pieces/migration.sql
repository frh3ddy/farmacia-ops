-- Lot pieces a Conteo inicial split between 2026-11-05 20:16 UTC (lots live) and the
-- deploy that added "splitFromId"/"splitInitialQuantity" don't record their source.
-- A piece is a batch with no receiving or creating adjustment, received up to a second
-- after a batch with "splitOut" (pieces sit 1 ms apart), on a product counted in that
-- window. Its starting units are exact: what's left + consumed + what it split off in turn.
-- A source is trusted only when its pieces' starting units add up to its "splitOut";
-- anything else (a tie between two sources, a batch loaded in the same second) is left
-- as opening stock. Pieces point at the root batch, as the split does now, and each
-- linked piece gets a BACKFILL_LOT_PIECE audit row.
WITH RECURSIVE
scope AS (
  SELECT DISTINCT e."productId", s."locationId"
  FROM "StockCountEntry" e
  JOIN "StockCount" s ON s."id" = e."stockCountId"
  WHERE e."countedAt" >= TIMESTAMP '2026-11-05 20:16:00'
),
batch AS (
  SELECT i.*
  FROM "Inventory" i
  JOIN scope ON scope."productId" = i."productId" AND scope."locationId" = i."locationId"
),
candidate AS (
  SELECT b.*
  FROM batch b
  WHERE b."splitFromId" IS NULL
    AND b."splitInitialQuantity" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "InventoryReceiving" r WHERE r."inventoryBatchId" = b."id")
    AND NOT EXISTS (SELECT 1 FROM "InventoryAdjustment" a WHERE a."createdBatchId" = b."id")
),
ranked AS (
  -- Each piece's nearest source received before it (a piece of a piece is nearer than the root).
  SELECT c."id" AS child, p."id" AS parent,
         rank() OVER (PARTITION BY c."id" ORDER BY p."receivedAt" DESC) AS nearness
  FROM candidate c
  JOIN batch p
    ON p."productId" = c."productId" AND p."locationId" = c."locationId" AND p."unitCost" = c."unitCost"
   AND p."splitOut" > 0 AND p."id" <> c."id"
   AND c."receivedAt" > p."receivedAt" AND c."receivedAt" <= p."receivedAt" + INTERVAL '1 second'
),
link AS (
  SELECT child, min(parent) AS parent
  FROM ranked
  WHERE nearness = 1
  GROUP BY child
  HAVING count(*) = 1
),
initial AS (
  SELECT c."id",
         c."quantity" + c."splitOut"
           + COALESCE((SELECT sum(ic."quantity") FROM "InventoryConsumption" ic WHERE ic."inventoryId" = c."id"), 0) AS units
  FROM candidate c
),
exact AS (
  SELECT p."id"
  FROM batch p
  JOIN link l ON l.parent = p."id"
  JOIN initial n ON n."id" = l.child
  GROUP BY p."id", p."splitOut"
  HAVING sum(n.units) = p."splitOut"
),
tree AS (
  -- From roots (exact sources that aren't pieces themselves) down through exact sources.
  SELECT l.child, l.parent AS root
  FROM link l
  JOIN exact x ON x."id" = l.parent
  WHERE l.parent NOT IN (SELECT child FROM ranked)
  UNION ALL
  SELECT l.child, t.root
  FROM tree t
  JOIN exact x ON x."id" = t.child
  JOIN link l ON l.parent = t.child
),
updated AS (
  UPDATE "Inventory" i
  SET "splitFromId" = t.root, "splitInitialQuantity" = n.units
  FROM tree t
  JOIN initial n ON n."id" = t.child
  WHERE i."id" = t.child
  RETURNING i."id", i."locationId", i."splitFromId", i."splitInitialQuantity"
)
-- One row per linked piece: the deploy log shows no row counts.
INSERT INTO "AuditLog" ("id", "locationId", "action", "entityType", "entityId", "details")
SELECT gen_random_uuid()::text, u."locationId", 'BACKFILL_LOT_PIECE', 'Inventory', u."id",
       jsonb_build_object('splitFromId', u."splitFromId", 'splitInitialQuantity', u."splitInitialQuantity")
FROM updated u;
