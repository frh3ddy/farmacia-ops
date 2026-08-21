/*
  Warnings:

  - You are about to drop the column `activeIngredient` on the `Product` table. All the data in the column will be lost.
  - You are about to drop the column `concentration` on the `Product` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "PharmaceuticalForm" AS ENUM ('TABLET', 'CAPSULE', 'SUSPENSION', 'SYRUP', 'CREAM', 'OINTMENT', 'GEL', 'INJECTION', 'DROPS', 'SPRAY', 'PATCH', 'SUPPOSITORY', 'INHALER', 'OTHER');

-- CreateEnum
CREATE TYPE "AdministrationRoute" AS ENUM ('ORAL', 'TOPICAL', 'INJECTABLE', 'OPHTHALMIC', 'OTIC', 'NASAL', 'RECTAL', 'VAGINAL', 'INHALED', 'SUBLINGUAL', 'OTHER');

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "activeIngredient",
DROP COLUMN "concentration",
ADD COLUMN     "isControlled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "medicationDefinitionId" TEXT,
ADD COLUMN     "searchAliases" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ActiveIngredient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "ActiveIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "form" "PharmaceuticalForm" NOT NULL,
    "route" "AdministrationRoute" NOT NULL,
    "strength" TEXT NOT NULL,

    CONSTRAINT "MedicationDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationDefinitionIngredient" (
    "medicationDefinitionId" TEXT NOT NULL,
    "activeIngredientId" TEXT NOT NULL,
    "amount" TEXT,

    CONSTRAINT "MedicationDefinitionIngredient_pkey" PRIMARY KEY ("medicationDefinitionId","activeIngredientId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActiveIngredient_name_key" ON "ActiveIngredient"("name");

-- CreateIndex
CREATE INDEX "MedicationDefinition_form_route_strength_idx" ON "MedicationDefinition"("form", "route", "strength");

-- CreateIndex
CREATE INDEX "Product_medicationDefinitionId_idx" ON "Product"("medicationDefinitionId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_medicationDefinitionId_fkey" FOREIGN KEY ("medicationDefinitionId") REFERENCES "MedicationDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationDefinitionIngredient" ADD CONSTRAINT "MedicationDefinitionIngredient_medicationDefinitionId_fkey" FOREIGN KEY ("medicationDefinitionId") REFERENCES "MedicationDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationDefinitionIngredient" ADD CONSTRAINT "MedicationDefinitionIngredient_activeIngredientId_fkey" FOREIGN KEY ("activeIngredientId") REFERENCES "ActiveIngredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
