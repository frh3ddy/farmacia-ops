-- lowMargin: margin on the selling price under this % (per store, default 20; was fixed at 10).
ALTER TABLE "StockAlertSettings" ADD COLUMN "lowMarginPct" INTEGER NOT NULL DEFAULT 20;
