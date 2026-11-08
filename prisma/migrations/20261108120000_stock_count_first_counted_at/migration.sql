-- When a product was first counted in a Conteo inicial; a recount overwrites countedAt, never this.
-- Rows that were already recounted lost their first time, so countedAt is the best backfill there is.
ALTER TABLE "StockCountEntry" ADD COLUMN "firstCountedAt" TIMESTAMP(3);
UPDATE "StockCountEntry" SET "firstCountedAt" = "countedAt";
ALTER TABLE "StockCountEntry" ALTER COLUMN "firstCountedAt" SET NOT NULL,
  ALTER COLUMN "firstCountedAt" SET DEFAULT CURRENT_TIMESTAMP;
