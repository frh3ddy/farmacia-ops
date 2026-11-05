-- Lots on the cost batch (tasks/opening-count-lots-epic.md): sales consume batches,
-- so a batch's lot shrinks as it sells. Receivings' lots are copied onto their batches.
ALTER TABLE "Inventory" ADD COLUMN "expiryDate" TIMESTAMP(3),
                        ADD COLUMN "lotNumber" TEXT,
                        ADD COLUMN "splitOut" INTEGER NOT NULL DEFAULT 0;

UPDATE "Inventory" i
SET "expiryDate" = r."expiryDate", "lotNumber" = r."batchNumber"
FROM "InventoryReceiving" r
WHERE r."inventoryBatchId" = i."id" AND (r."expiryDate" IS NOT NULL OR r."batchNumber" IS NOT NULL);
