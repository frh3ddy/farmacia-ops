-- Add migrationStatus column to CostApproval if it doesn't exist
-- First, create the enum type if it doesn't exist
DO $$ BEGIN
    CREATE TYPE "MigrationStatus" AS ENUM ('PENDING', 'APPROVED', 'SKIPPED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add the column if it doesn't exist, then create index
DO $$ 
DECLARE
    column_exists BOOLEAN;
    index_exists BOOLEAN;
BEGIN
    -- Check if column exists
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'CostApproval' 
        AND column_name = 'migrationStatus'
    ) INTO column_exists;
    
    -- Add column if it doesn't exist
    IF NOT column_exists THEN
        ALTER TABLE "CostApproval" ADD COLUMN "migrationStatus" "MigrationStatus" NOT NULL DEFAULT 'PENDING';
        RAISE NOTICE 'Column migrationStatus added successfully';
    ELSE
        RAISE NOTICE 'Column migrationStatus already exists';
    END IF;
    
    -- Re-check if column exists (in case it was just added)
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'CostApproval' 
        AND column_name = 'migrationStatus'
    ) INTO column_exists;
    
    -- Check if index exists
    SELECT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE tablename = 'CostApproval' 
        AND indexname = 'CostApproval_migrationStatus_idx'
    ) INTO index_exists;
    
    -- Create index if it doesn't exist and column exists
    IF NOT index_exists AND column_exists THEN
        CREATE INDEX "CostApproval_migrationStatus_idx" ON "CostApproval"("migrationStatus");
        RAISE NOTICE 'Index CostApproval_migrationStatus_idx created successfully';
    ELSIF index_exists THEN
        RAISE NOTICE 'Index CostApproval_migrationStatus_idx already exists';
    ELSE
        RAISE NOTICE 'Cannot create index: column migrationStatus does not exist';
    END IF;
END $$;
