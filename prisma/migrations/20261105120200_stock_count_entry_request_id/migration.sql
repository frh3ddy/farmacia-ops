-- A count's dedup key (a retry after commit returns the first result), and the
-- entry's adjustment as a real foreign key.
ALTER TABLE "StockCountEntry" ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX "StockCountEntry_clientRequestId_key" ON "StockCountEntry"("clientRequestId");
CREATE UNIQUE INDEX "StockCountEntry_adjustmentId_key" ON "StockCountEntry"("adjustmentId");

ALTER TABLE "StockCountEntry" ADD CONSTRAINT "StockCountEntry_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "InventoryAdjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
