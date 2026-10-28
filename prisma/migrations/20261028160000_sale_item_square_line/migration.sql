-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "squareLineUid" TEXT;

-- CreateIndex
CREATE INDEX "SaleItem_squareLineUid_idx" ON "SaleItem"("squareLineUid");
