/*
  Warnings:

  - You are about to drop the column `amount` on the `MedicationDefinitionIngredient` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "Empaque" AS ENUM ('FRASCO', 'FRASCO_AMPULA', 'TUBO', 'BLISTER', 'SOBRE', 'AMPOLLETA', 'GOTERO', 'AEROSOL', 'PARCHE', 'CAJA');

-- AlterTable
ALTER TABLE "MedicationDefinitionIngredient" DROP COLUMN "amount",
ADD COLUMN     "concentracionUnidad" TEXT,
ADD COLUMN     "concentracionValor" DECIMAL(65,30),
ADD COLUMN     "orden" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "cantidad" INTEGER,
ADD COLUMN     "empaquePrimario" "Empaque",
ADD COLUMN     "empaqueSecundario" "Empaque",
ADD COLUMN     "nombreManual" TEXT,
ADD COLUMN     "presentacionManual" TEXT;
