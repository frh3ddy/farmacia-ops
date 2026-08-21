-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdjustmentType" ADD VALUE 'BREAK_BULK_OUT';
ALTER TYPE "AdjustmentType" ADD VALUE 'BREAK_BULK_IN';

-- DropForeignKey
ALTER TABLE "CatalogMapping" DROP CONSTRAINT "CatalogMapping_unidadVentaId_fkey";

-- DropForeignKey
ALTER TABLE "UnidadVenta" DROP CONSTRAINT "UnidadVenta_productId_fkey";

-- DropIndex
DROP INDEX "CatalogMapping_unidadVentaId_key";

-- AlterTable
ALTER TABLE "CatalogMapping" DROP COLUMN "unidadVentaId";

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "permiteSuelto",
ADD COLUMN     "sueltoProductId" TEXT;

-- DropTable
DROP TABLE "UnidadVenta";

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_sueltoProductId_fkey" FOREIGN KEY ("sueltoProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

