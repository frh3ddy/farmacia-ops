-- lowMargin: margin on the selling price under this % (per store; was fixed at 10).
ALTER TABLE "StockAlertSettings" ADD COLUMN "lowMarginPct" INTEGER NOT NULL DEFAULT 10;
