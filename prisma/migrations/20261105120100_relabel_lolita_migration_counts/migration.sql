-- The six Corrección de Conteo entered at Farmacia Lolita on 2026-11-04 fixed stock
-- the migration loaded wrong (owner confirmed: no loss), so they become Conteo
-- inicial and leave shrinkage. Stock, batches, costs and Square are untouched.
-- Its own migration: OPENING_COUNT can't be used in the transaction that added it.
WITH relabeled AS (
  UPDATE "InventoryAdjustment"
  SET "type" = 'OPENING_COUNT'
  WHERE "type" = 'COUNT_CORRECTION'
    AND "id" IN (
      '31e5eb4b-d39e-4896-b18a-7102f5e589b4',
      'e000c3ef-f65c-4705-a049-fbc84ff0464d',
      '2659834b-5b0f-4a3d-b6b3-e8bfdb4926e6',
      '60ef0212-6791-4e68-9ad4-02fcc735f89b',
      '0bba5d62-d537-46c0-8547-0bb9f024b2c3',
      'ba17fe40-0d78-4e3c-9445-661070c645fe'
    )
  RETURNING "id", "locationId"
)
INSERT INTO "AuditLog" ("id", "locationId", "action", "entityType", "entityId", "details")
SELECT gen_random_uuid()::text, "locationId", 'RELABEL_ADJUSTMENT_TYPE', 'InventoryAdjustment', "id",
       '{"from": "COUNT_CORRECTION", "to": "OPENING_COUNT", "reason": "Migration stock fix entered as a count correction (tasks/opening-count-epic.md step 2b)"}'::jsonb
FROM relabeled;
