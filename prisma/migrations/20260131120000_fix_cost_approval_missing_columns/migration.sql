-- Fix CostApproval: add migrationStatus and selling price columns if missing
-- The migrationStatus column was never added because 20250101000000 ran before CostApproval existed.
-- This migration safely adds all expected columns if they don't exist.

-- CreateEnum (idempotent)
DO $$ BEGIN
    CREATE TYPE "MigrationStatus" AS ENUM ('PENDING', 'APPROVED', 'SKIPPED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add migrationStatus if missing
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'CostApproval') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CostApproval' AND column_name = 'migrationStatus') THEN
            ALTER TABLE "CostApproval" ADD COLUMN "migrationStatus" "MigrationStatus" NOT NULL DEFAULT 'PENDING';
        END IF;
    END IF;
END $$;

-- Add selling price columns if missing
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'CostApproval') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CostApproval' AND column_name = 'sellingPriceCents') THEN
            ALTER TABLE "CostApproval" ADD COLUMN "sellingPriceCents" INTEGER;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CostApproval' AND column_name = 'sellingPriceCurrency') THEN
            ALTER TABLE "CostApproval" ADD COLUMN "sellingPriceCurrency" TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CostApproval' AND column_name = 'sellingPriceRangeMinCents') THEN
            ALTER TABLE "CostApproval" ADD COLUMN "sellingPriceRangeMinCents" INTEGER;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CostApproval' AND column_name = 'sellingPriceRangeMaxCents') THEN
            ALTER TABLE "CostApproval" ADD COLUMN "sellingPriceRangeMaxCents" INTEGER;
        END IF;
    END IF;
END $$;

-- Create migrationStatus index if missing
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'CostApproval') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'CostApproval' AND indexname = 'CostApproval_migrationStatus_idx') THEN
            CREATE INDEX "CostApproval_migrationStatus_idx" ON "CostApproval"("migrationStatus");
        END IF;
    END IF;
END $$;
