-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "shippedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferLine" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "sourceInventoryId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "quantityReceived" INTEGER,
    "unitCost" DECIMAL(65,30) NOT NULL,
    "originalReceivedAt" TIMESTAMP(3) NOT NULL,
    "destinationInventoryId" TEXT,

    CONSTRAINT "TransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Transfer_productId_idx" ON "Transfer"("productId");

-- CreateIndex
CREATE INDEX "Transfer_fromLocationId_idx" ON "Transfer"("fromLocationId");

-- CreateIndex
CREATE INDEX "Transfer_toLocationId_idx" ON "Transfer"("toLocationId");

-- CreateIndex
CREATE INDEX "Transfer_status_idx" ON "Transfer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TransferLine_destinationInventoryId_key" ON "TransferLine"("destinationInventoryId");

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_sourceInventoryId_fkey" FOREIGN KEY ("sourceInventoryId") REFERENCES "Inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_destinationInventoryId_fkey" FOREIGN KEY ("destinationInventoryId") REFERENCES "Inventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

