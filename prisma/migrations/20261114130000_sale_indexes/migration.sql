-- Product rows read each store's sales today for stockAlert.lastSoldAt, so
-- find them without reading every sale and line.
CREATE INDEX "Sale_locationId_createdAt_idx" ON "Sale"("locationId", "createdAt");
CREATE INDEX "SaleItem_saleId_idx" ON "SaleItem"("saleId");
