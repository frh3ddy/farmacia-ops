-- CreateTable
CREATE TABLE "SalesHistoryLine" (
    "id" TEXT NOT NULL,
    "squareOrderId" TEXT NOT NULL,
    "squareLineUid" TEXT NOT NULL,
    "squarePaymentId" TEXT,
    "locationId" TEXT NOT NULL,
    "productId" TEXT,
    "squareVariationId" TEXT,
    "quantity" INTEGER NOT NULL,
    "soldAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesHistoryLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesHistoryLine_productId_locationId_soldAt_idx" ON "SalesHistoryLine"("productId", "locationId", "soldAt");

-- CreateIndex
CREATE INDEX "SalesHistoryLine_locationId_soldAt_idx" ON "SalesHistoryLine"("locationId", "soldAt");

-- CreateIndex
CREATE INDEX "SalesHistoryLine_squarePaymentId_idx" ON "SalesHistoryLine"("squarePaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesHistoryLine_squareOrderId_squareLineUid_key" ON "SalesHistoryLine"("squareOrderId", "squareLineUid");

-- AddForeignKey
ALTER TABLE "SalesHistoryLine" ADD CONSTRAINT "SalesHistoryLine_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesHistoryLine" ADD CONSTRAINT "SalesHistoryLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

