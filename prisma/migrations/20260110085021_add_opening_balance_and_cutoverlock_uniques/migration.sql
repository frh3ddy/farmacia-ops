-- CreateIndex
-- Index on productId for Inventory table (non-unique index for query performance)
CREATE INDEX IF NOT EXISTS "Inventory_productId_idx" ON "Inventory"("productId");

-- CreateIndex
-- Index on locationId for Inventory table (non-unique index for query performance)
CREATE INDEX IF NOT EXISTS "Inventory_locationId_idx" ON "Inventory"("locationId");

-- CreateIndex
-- Index on source for Inventory table (non-unique index for query performance)
CREATE INDEX IF NOT EXISTS "Inventory_source_idx" ON "Inventory"("source");

-- CreateIndex
-- Unique constraint on Inventory(productId, locationId, source) to prevent duplicate opening balances
-- This will fail if duplicates exist, which is expected - duplicates must be resolved before applying this migration
CREATE UNIQUE INDEX "Inventory_productId_locationId_source_key" ON "Inventory"("productId", "locationId", "source");

-- CreateIndex
-- Index on locationId for CutoverLock table (non-unique index for query performance)
CREATE INDEX IF NOT EXISTS "CutoverLock_locationId_idx" ON "CutoverLock"("locationId");

-- CreateIndex
-- Index on cutoverDate for CutoverLock table (non-unique index for query performance)
CREATE INDEX IF NOT EXISTS "CutoverLock_cutoverDate_idx" ON "CutoverLock"("cutoverDate");

-- CreateIndex
-- Unique constraint on CutoverLock(locationId, cutoverDate) to prevent duplicate cutover locks
-- This will fail if duplicates exist, which is expected - duplicates must be resolved before applying this migration
CREATE UNIQUE INDEX "CutoverLock_locationId_cutoverDate_key" ON "CutoverLock"("locationId", "cutoverDate");
