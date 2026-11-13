-- Who resumed a paused product by hand (stock-alerts O5); null for an automatic resume on receiving.
ALTER TABLE "ProductStoreStatus" ADD COLUMN "resumedByEmployeeId" TEXT;
