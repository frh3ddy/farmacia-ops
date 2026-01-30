-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "MigrationStatus" AS ENUM ('PENDING', 'APPROVED', 'SKIPPED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable (only if table exists)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CostApproval') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CostApproval' AND column_name = 'migrationStatus') THEN
            ALTER TABLE "CostApproval" ADD COLUMN "migrationStatus" "MigrationStatus" NOT NULL DEFAULT 'PENDING';
        END IF;
    END IF;
END $$;

-- CreateIndex (only if table exists)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CostApproval') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'CostApproval' AND indexname = 'CostApproval_migrationStatus_idx') THEN
            CREATE INDEX "CostApproval_migrationStatus_idx" ON "CostApproval"("migrationStatus");
        END IF;
    END IF;
END $$;

