-- CreateEnum
CREATE TYPE "MedicationType" AS ENUM ('GENERICO', 'DE_MARCA', 'SIMILAR');

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "activeIngredient" TEXT,
ADD COLUMN     "concentration" TEXT,
ADD COLUMN     "labId" TEXT,
ADD COLUMN     "medicationType" "MedicationType",
ADD COLUMN     "presentation" TEXT,
ADD COLUMN     "requiresPrescription" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Laboratory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Laboratory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Laboratory_name_key" ON "Laboratory"("name");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_labId_fkey" FOREIGN KEY ("labId") REFERENCES "Laboratory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
