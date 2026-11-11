-- CreateEnum
CREATE TYPE "PauseReason" AS ENUM ('SUPPLIER_UNAVAILABLE', 'REPLACED_BY_EQUIVALENT', 'SLOW_MOVER', 'OTHER');

-- CreateEnum
CREATE TYPE "ResumeCause" AS ENUM ('STOCK_RECEIVED', 'MANUAL');

-- CreateEnum
CREATE TYPE "PauseSuggestionKind" AS ENUM ('NO_SALES_AT_ZERO', 'SLOW_WITH_STOCKOUTS', 'EQUIVALENT_SELLING');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "equivalenceGroupId" TEXT;

-- CreateTable
CREATE TABLE "ProductStoreStatus" (
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "pauseReason" "PauseReason",
    "pauseNote" TEXT,
    "replacedByProductId" TEXT,
    "pausedByEmployeeId" TEXT,
    "resumedAt" TIMESTAMP(3),
    "resumeCause" "ResumeCause",

    CONSTRAINT "ProductStoreStatus_pkey" PRIMARY KEY ("productId","locationId")
);

-- CreateTable
CREATE TABLE "StockDay" (
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "quantity" INTEGER NOT NULL,
    "restocked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "StockDay_pkey" PRIMARY KEY ("productId","locationId","day")
);

-- CreateTable
CREATE TABLE "ProductStockStats" (
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "unitsSold" INTEGER NOT NULL,
    "weeksWithSales" INTEGER NOT NULL,
    "lastSoldAt" TIMESTAMP(3),
    "typicalOnHand" INTEGER NOT NULL,
    "daysAtZero" INTEGER NOT NULL,
    "stockOuts" INTEGER NOT NULL,
    "zeroSince" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductStockStats_pkey" PRIMARY KEY ("productId","locationId")
);

-- CreateTable
CREATE TABLE "PauseSuggestionDismissal" (
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "kind" "PauseSuggestionKind" NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedByEmployeeId" TEXT,

    CONSTRAINT "PauseSuggestionDismissal_pkey" PRIMARY KEY ("productId","locationId","kind")
);

-- CreateTable
CREATE TABLE "StockAlertSettings" (
    "locationId" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL DEFAULT 90,
    "coverDays" INTEGER NOT NULL DEFAULT 14,
    "regularMinWeeks" INTEGER NOT NULL DEFAULT 4,
    "slowMaxUnits" INTEGER NOT NULL DEFAULT 2,
    "slowMinDaysAtZero" INTEGER NOT NULL DEFAULT 30,
    "equivalentMinUnits" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "StockAlertSettings_pkey" PRIMARY KEY ("locationId")
);

-- CreateTable
CREATE TABLE "EquivalenceGroup" (
    "id" TEXT NOT NULL,
    "createdByEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquivalenceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductStoreStatus_locationId_pausedAt_idx" ON "ProductStoreStatus"("locationId", "pausedAt");

-- CreateIndex
CREATE INDEX "StockDay_locationId_day_idx" ON "StockDay"("locationId", "day");

-- CreateIndex
CREATE INDEX "ProductStockStats_locationId_idx" ON "ProductStockStats"("locationId");

-- CreateIndex
CREATE INDEX "Product_equivalenceGroupId_idx" ON "Product"("equivalenceGroupId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_equivalenceGroupId_fkey" FOREIGN KEY ("equivalenceGroupId") REFERENCES "EquivalenceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStoreStatus" ADD CONSTRAINT "ProductStoreStatus_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStoreStatus" ADD CONSTRAINT "ProductStoreStatus_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStoreStatus" ADD CONSTRAINT "ProductStoreStatus_replacedByProductId_fkey" FOREIGN KEY ("replacedByProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDay" ADD CONSTRAINT "StockDay_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDay" ADD CONSTRAINT "StockDay_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStockStats" ADD CONSTRAINT "ProductStockStats_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStockStats" ADD CONSTRAINT "ProductStockStats_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PauseSuggestionDismissal" ADD CONSTRAINT "PauseSuggestionDismissal_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PauseSuggestionDismissal" ADD CONSTRAINT "PauseSuggestionDismissal_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAlertSettings" ADD CONSTRAINT "StockAlertSettings_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Seed: every store starts with the default thresholds.
INSERT INTO "StockAlertSettings" ("locationId") SELECT id FROM "Location" ON CONFLICT DO NOTHING;

-- Product rows carry stockAlert, so a pause or a change in what the alert is
-- computed from re-sends the product (product_change_stamp migration). The
-- nightly stats rewrite every row; only the fields the alert reads count.
CREATE TRIGGER product_store_status_touch_product AFTER INSERT OR UPDATE OR DELETE ON "ProductStoreStatus"
  FOR EACH ROW EXECUTE FUNCTION product_touch_from_child();
CREATE TRIGGER product_stock_stats_insert_touch_product AFTER INSERT OR DELETE ON "ProductStockStats"
  FOR EACH ROW EXECUTE FUNCTION product_touch_from_child();
CREATE TRIGGER product_stock_stats_update_touch_product AFTER UPDATE ON "ProductStockStats"
  FOR EACH ROW WHEN (
    (OLD."windowDays", OLD."unitsSold", OLD."weeksWithSales", OLD."typicalOnHand", OLD."zeroSince")
    IS DISTINCT FROM (NEW."windowDays", NEW."unitsSold", NEW."weeksWithSales", NEW."typicalOnHand", NEW."zeroSince")
  ) EXECUTE FUNCTION product_touch_from_child();
