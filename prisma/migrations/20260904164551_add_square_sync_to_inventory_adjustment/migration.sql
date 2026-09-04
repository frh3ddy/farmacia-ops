-- AlterTable
ALTER TABLE "InventoryAdjustment" ADD COLUMN     "squareSyncError" TEXT,
ADD COLUMN     "squareSynced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "squareSyncedAt" TIMESTAMP(3);
