-- AlterTable
-- Add price caching fields to CatalogMapping table
ALTER TABLE "CatalogMapping" ADD COLUMN IF NOT EXISTS "priceCents" DECIMAL(65,30),
ADD COLUMN IF NOT EXISTS "currency" TEXT,
ADD COLUMN IF NOT EXISTS "priceSyncedAt" TIMESTAMP(3);
