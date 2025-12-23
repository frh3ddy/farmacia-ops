-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "contactInfo" TEXT,
ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "SupplierProduct" ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SupplierCostHistory" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "unitCost" DECIMAL(65,30) NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierCostHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierCostHistory_productId_supplierId_idx" ON "SupplierCostHistory"("productId", "supplierId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierCostHistory_isCurrent_idx" ON "SupplierCostHistory"("isCurrent");

-- AddForeignKey
ALTER TABLE "SupplierCostHistory" ADD CONSTRAINT "SupplierCostHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCostHistory" ADD CONSTRAINT "SupplierCostHistory_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

