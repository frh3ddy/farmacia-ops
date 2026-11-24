-- The owner's "who receives from suppliers" confirmation, for the setup checklist.
-- Business-wide: written to every open store's row at once. The touch trigger
-- only fires on coverDays/regularMinWeeks, so this re-sends nothing.
ALTER TABLE "StockAlertSettings" ADD COLUMN "receivingReviewedAt" TIMESTAMP(3);
ALTER TABLE "StockAlertSettings" ADD COLUMN "receivingReviewedBy" TEXT;
