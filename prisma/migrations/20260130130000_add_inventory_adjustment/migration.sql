-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('DAMAGE', 'THEFT', 'EXPIRED', 'COUNT_CORRECTION', 'FOUND', 'RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'WRITE_OFF', 'OTHER');

-- CreateTable
CREATE TABLE "InventoryAdjustment" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "notes" TEXT,
    "unitCost" DECIMAL(65,30) NOT NULL,
    "totalCost" DECIMAL(65,30) NOT NULL,
    "createdBatchId" TEXT,
    "adjustedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adjustedBy" TEXT,
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryAdjustment_createdBatchId_key" ON "InventoryAdjustment"("createdBatchId");

-- CreateIndex
CREATE INDEX "InventoryAdjustment_locationId_idx" ON "InventoryAdjustment"("locationId");

-- CreateIndex
CREATE INDEX "InventoryAdjustment_productId_idx" ON "InventoryAdjustment"("productId");

-- CreateIndex
CREATE INDEX "InventoryAdjustment_type_idx" ON "InventoryAdjustment"("type");

-- CreateIndex
CREATE INDEX "InventoryAdjustment_adjustedAt_idx" ON "InventoryAdjustment"("adjustedAt");

-- CreateIndex
CREATE INDEX "InventoryAdjustment_effectiveDate_idx" ON "InventoryAdjustment"("effectiveDate");

-- AddForeignKey
ALTER TABLE "InventoryAdjustment" ADD CONSTRAINT "InventoryAdjustment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAdjustment" ADD CONSTRAINT "InventoryAdjustment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAdjustment" ADD CONSTRAINT "InventoryAdjustment_createdBatchId_fkey" FOREIGN KEY ("createdBatchId") REFERENCES "Inventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (Link InventoryConsumption.adjustmentId to InventoryAdjustment)
ALTER TABLE "InventoryConsumption" ADD CONSTRAINT "InventoryConsumption_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "InventoryAdjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
