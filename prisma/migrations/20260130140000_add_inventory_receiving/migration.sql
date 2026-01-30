-- DropIndex (Remove unique constraint to allow multiple FIFO batches)
DROP INDEX IF EXISTS "Inventory_productId_locationId_source_key";

-- CreateIndex (Add receivedAt index for FIFO ordering)
CREATE INDEX IF NOT EXISTS "Inventory_receivedAt_idx" ON "Inventory"("receivedAt");

-- CreateTable
CREATE TABLE "InventoryReceiving" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierId" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(65,30) NOT NULL,
    "totalCost" DECIMAL(65,30) NOT NULL,
    "invoiceNumber" TEXT,
    "purchaseOrderId" TEXT,
    "batchNumber" TEXT,
    "expiryDate" TIMESTAMP(3),
    "manufacturingDate" TIMESTAMP(3),
    "inventoryBatchId" TEXT NOT NULL,
    "squareSynced" BOOLEAN NOT NULL DEFAULT false,
    "squareSyncedAt" TIMESTAMP(3),
    "squareSyncError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" TEXT,
    "notes" TEXT,

    CONSTRAINT "InventoryReceiving_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReceiving_inventoryBatchId_key" ON "InventoryReceiving"("inventoryBatchId");

-- CreateIndex
CREATE INDEX "InventoryReceiving_locationId_idx" ON "InventoryReceiving"("locationId");

-- CreateIndex
CREATE INDEX "InventoryReceiving_productId_idx" ON "InventoryReceiving"("productId");

-- CreateIndex
CREATE INDEX "InventoryReceiving_supplierId_idx" ON "InventoryReceiving"("supplierId");

-- CreateIndex
CREATE INDEX "InventoryReceiving_receivedAt_idx" ON "InventoryReceiving"("receivedAt");

-- CreateIndex
CREATE INDEX "InventoryReceiving_invoiceNumber_idx" ON "InventoryReceiving"("invoiceNumber");

-- CreateIndex
CREATE INDEX "InventoryReceiving_batchNumber_idx" ON "InventoryReceiving"("batchNumber");

-- AddForeignKey
ALTER TABLE "InventoryReceiving" ADD CONSTRAINT "InventoryReceiving_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceiving" ADD CONSTRAINT "InventoryReceiving_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceiving" ADD CONSTRAINT "InventoryReceiving_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceiving" ADD CONSTRAINT "InventoryReceiving_inventoryBatchId_fkey" FOREIGN KEY ("inventoryBatchId") REFERENCES "Inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
