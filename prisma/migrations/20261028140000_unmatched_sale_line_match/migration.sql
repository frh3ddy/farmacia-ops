-- AlterTable
ALTER TABLE "UnmatchedSaleLine" ADD COLUMN     "matchedAt" TIMESTAMP(3),
ADD COLUMN     "matchedBy" TEXT,
ADD COLUMN     "matchedSaleItemId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedSaleLine_matchedSaleItemId_key" ON "UnmatchedSaleLine"("matchedSaleItemId");

-- AddForeignKey
ALTER TABLE "UnmatchedSaleLine" ADD CONSTRAINT "UnmatchedSaleLine_matchedSaleItemId_fkey" FOREIGN KEY ("matchedSaleItemId") REFERENCES "SaleItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
