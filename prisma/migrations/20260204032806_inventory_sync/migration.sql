-- AlterTable
ALTER TABLE "Supplier" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "idx_supplier_normalized_name" RENAME TO "Supplier_normalizedName_key";
