-- AlterTable: add client-supplied dedup key for offline-queue replay (iOS).
-- Nullable + unique: existing rows keep NULL (Postgres allows multiple NULLs
-- in a unique index), so this is a pure additive change.
ALTER TABLE "InventoryAdjustment" ADD COLUMN "clientRequestId" TEXT;
CREATE UNIQUE INDEX "InventoryAdjustment_clientRequestId_key" ON "InventoryAdjustment"("clientRequestId");

ALTER TABLE "InventoryReceiving" ADD COLUMN "clientRequestId" TEXT;
CREATE UNIQUE INDEX "InventoryReceiving_clientRequestId_key" ON "InventoryReceiving"("clientRequestId");

ALTER TABLE "Expense" ADD COLUMN "clientRequestId" TEXT;
CREATE UNIQUE INDEX "Expense_clientRequestId_key" ON "Expense"("clientRequestId");
