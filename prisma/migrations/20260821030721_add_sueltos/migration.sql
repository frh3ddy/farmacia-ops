-- AlterTable
ALTER TABLE "CatalogMapping" ADD COLUMN     "unidadVentaId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "permiteSuelto" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "UnidadVenta" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "baseUnits" INTEGER NOT NULL,
    "priceCents" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "UnidadVenta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnidadVenta_productId_idx" ON "UnidadVenta"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogMapping_unidadVentaId_key" ON "CatalogMapping"("unidadVentaId");

-- AddForeignKey
ALTER TABLE "CatalogMapping" ADD CONSTRAINT "CatalogMapping_unidadVentaId_fkey" FOREIGN KEY ("unidadVentaId") REFERENCES "UnidadVenta"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnidadVenta" ADD CONSTRAINT "UnidadVenta_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

