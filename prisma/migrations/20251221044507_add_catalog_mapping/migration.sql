-- CreateTable
CREATE TABLE "CatalogMapping" (
    "id" TEXT NOT NULL,
    "squareVariationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogMapping_productId_idx" ON "CatalogMapping"("productId");

-- CreateIndex
CREATE INDEX "CatalogMapping_locationId_idx" ON "CatalogMapping"("locationId");

-- CreateIndex
CREATE INDEX "CatalogMapping_squareVariationId_idx" ON "CatalogMapping"("squareVariationId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogMapping_squareVariationId_locationId_key" ON "CatalogMapping"("squareVariationId", "locationId");

-- AddForeignKey
ALTER TABLE "CatalogMapping" ADD CONSTRAINT "CatalogMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogMapping" ADD CONSTRAINT "CatalogMapping_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
