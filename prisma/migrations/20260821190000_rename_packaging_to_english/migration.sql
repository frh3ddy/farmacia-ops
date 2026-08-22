-- Rename Spanish identifiers to English. Every statement below is a RENAME
-- (column/type/enum-value/constraint), not a drop+recreate, so existing row
-- data is preserved automatically — hand-written to replace Prisma's default
-- non-interactive diff, which proposed destructive DROP COLUMN/ADD COLUMN
-- pairs (and a full enum-recreate) for what are really just renames.

-- Empaque -> PackagingType (type rename, then rename each changed value)
ALTER TYPE "Empaque" RENAME TO "PackagingType";
ALTER TYPE "PackagingType" RENAME VALUE 'FRASCO' TO 'BOTTLE';
ALTER TYPE "PackagingType" RENAME VALUE 'FRASCO_AMPULA' TO 'VIAL';
ALTER TYPE "PackagingType" RENAME VALUE 'TUBO' TO 'TUBE';
ALTER TYPE "PackagingType" RENAME VALUE 'SOBRE' TO 'SACHET';
ALTER TYPE "PackagingType" RENAME VALUE 'AMPOLLETA' TO 'AMPOULE';
ALTER TYPE "PackagingType" RENAME VALUE 'GOTERO' TO 'DROPPER_BOTTLE';
ALTER TYPE "PackagingType" RENAME VALUE 'PARCHE' TO 'PATCH';
ALTER TYPE "PackagingType" RENAME VALUE 'CAJA' TO 'BOX';
-- BLISTER and AEROSOL are unchanged (already English).

-- MedicationType enum values
ALTER TYPE "MedicationType" RENAME VALUE 'GENERICO' TO 'GENERIC';
ALTER TYPE "MedicationType" RENAME VALUE 'DE_MARCA' TO 'BRAND';
-- SIMILAR is unchanged.

-- Product columns
ALTER TABLE "Product" RENAME COLUMN "empaquePrimario" TO "primaryPackaging";
ALTER TABLE "Product" RENAME COLUMN "empaqueSecundario" TO "secondaryPackaging";
ALTER TABLE "Product" RENAME COLUMN "cantidad" TO "quantity";
ALTER TABLE "Product" RENAME COLUMN "contenidoPrimario" TO "primaryContent";
ALTER TABLE "Product" RENAME COLUMN "nombreManual" TO "manualName";
ALTER TABLE "Product" RENAME COLUMN "presentacionManual" TO "manualPresentation";
ALTER TABLE "Product" RENAME COLUMN "sueltoProductId" TO "looseProductId";
ALTER TABLE "Product" RENAME CONSTRAINT "Product_sueltoProductId_fkey" TO "Product_looseProductId_fkey";

-- MedicationDefinitionIngredient columns
ALTER TABLE "MedicationDefinitionIngredient" RENAME COLUMN "concentracionValor" TO "concentrationValue";
ALTER TABLE "MedicationDefinitionIngredient" RENAME COLUMN "concentracionUnidad" TO "concentrationUnit";
ALTER TABLE "MedicationDefinitionIngredient" RENAME COLUMN "orden" TO "order";
