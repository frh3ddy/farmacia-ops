-- CreateTable: InventoryConsumption
-- This table tracks FIFO consumption of inventory batches for audit trail

CREATE TABLE "InventoryConsumption" (
    "id" TEXT NOT NULL,
    "inventoryId" TEXT NOT NULL,
    "saleItemId" TEXT,
    "adjustmentId" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(65,30) NOT NULL,
    "totalCost" DECIMAL(65,30) NOT NULL,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryConsumption_inventoryId_idx" ON "InventoryConsumption"("inventoryId");

-- CreateIndex
CREATE INDEX "InventoryConsumption_saleItemId_idx" ON "InventoryConsumption"("saleItemId");

-- CreateIndex
CREATE INDEX "InventoryConsumption_adjustmentId_idx" ON "InventoryConsumption"("adjustmentId");

-- CreateIndex
CREATE INDEX "InventoryConsumption_consumedAt_idx" ON "InventoryConsumption"("consumedAt");

-- AddForeignKey
ALTER TABLE "InventoryConsumption" ADD CONSTRAINT "InventoryConsumption_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "Inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryConsumption" ADD CONSTRAINT "InventoryConsumption_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
