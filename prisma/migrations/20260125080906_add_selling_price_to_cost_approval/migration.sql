-- AlterTable
ALTER TABLE "CostApproval" ADD COLUMN     "sellingPriceCents" INTEGER,
ADD COLUMN     "sellingPriceCurrency" TEXT,
ADD COLUMN     "sellingPriceRangeMinCents" INTEGER,
ADD COLUMN     "sellingPriceRangeMaxCents" INTEGER;
