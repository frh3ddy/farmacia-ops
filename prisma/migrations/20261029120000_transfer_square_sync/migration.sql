-- A received transfer's Square sync result, so a failed sync can be retried.
-- Transfers received before this have no recorded result and can't be retried.
ALTER TABLE "Transfer" ADD COLUMN "squareSynced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "squareSyncedAt" TIMESTAMP(3),
ADD COLUMN "squareSyncError" TEXT;
