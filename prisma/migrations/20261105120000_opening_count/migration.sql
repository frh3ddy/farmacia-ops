-- Conteo inicial (tasks/opening-count-epic.md). The new enum value can't be used
-- in this transaction, so the relabel of existing adjustments is its own migration.
ALTER TYPE "AdjustmentType" ADD VALUE 'OPENING_COUNT';

CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "openLocationId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedBy" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockCountEntry" (
    "id" TEXT NOT NULL,
    "stockCountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "countedQuantity" INTEGER NOT NULL,
    "previousQuantity" INTEGER NOT NULL,
    "adjustmentId" TEXT,
    "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "countedBy" TEXT,

    CONSTRAINT "StockCountEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockCount_openLocationId_key" ON "StockCount"("openLocationId");
CREATE INDEX "StockCount_locationId_idx" ON "StockCount"("locationId");
CREATE UNIQUE INDEX "StockCountEntry_stockCountId_productId_key" ON "StockCountEntry"("stockCountId", "productId");

ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountEntry" ADD CONSTRAINT "StockCountEntry_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountEntry" ADD CONSTRAINT "StockCountEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
