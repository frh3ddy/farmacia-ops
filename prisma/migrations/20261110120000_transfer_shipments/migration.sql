-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "receiveOnSend" BOOLEAN NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "createdBy" TEXT,
    "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN "shipmentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_clientRequestId_key" ON "Shipment"("clientRequestId");
CREATE INDEX "Shipment_fromLocationId_idx" ON "Shipment"("fromLocationId");
CREATE INDEX "Shipment_toLocationId_idx" ON "Shipment"("toLocationId");
CREATE INDEX "Transfer_shipmentId_idx" ON "Transfer"("shipmentId");

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
