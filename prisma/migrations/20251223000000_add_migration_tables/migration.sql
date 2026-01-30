-- AlterTable (only add columns if they don't exist)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Inventory') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Inventory' AND column_name = 'source') THEN
            ALTER TABLE "Inventory" ADD COLUMN "source" TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Inventory' AND column_name = 'costSource') THEN
            ALTER TABLE "Inventory" ADD COLUMN "costSource" TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Inventory' AND column_name = 'migrationId') THEN
            ALTER TABLE "Inventory" ADD COLUMN "migrationId" TEXT;
        END IF;
    END IF;
END $$;

-- CreateTable (only if it doesn't exist)
CREATE TABLE IF NOT EXISTS "CostApproval" (
    "id" TEXT NOT NULL,
    "cutoverId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "approvedCost" DECIMAL(65,30) NOT NULL,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,

    CONSTRAINT "CostApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable (only if it doesn't exist)
CREATE TABLE IF NOT EXISTS "Cutover" (
    "id" TEXT NOT NULL,
    "cutoverDate" TIMESTAMP(3) NOT NULL,
    "costBasis" TEXT NOT NULL,
    "ownerApproved" BOOLEAN NOT NULL,
    "ownerApprovedAt" TIMESTAMP(3),
    "ownerApprovedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cutover_pkey" PRIMARY KEY ("id")
);

-- CreateTable (only if it doesn't exist)
CREATE TABLE IF NOT EXISTS "CutoverLock" (
    "id" TEXT NOT NULL,
    "locationId" TEXT,
    "cutoverDate" TIMESTAMP(3) NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT true,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,

    CONSTRAINT "CutoverLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (only if it doesn't exist)
CREATE UNIQUE INDEX IF NOT EXISTS "CostApproval_cutoverId_productId_key" ON "CostApproval"("cutoverId", "productId");

-- CreateIndex (only if it doesn't exist)
CREATE INDEX IF NOT EXISTS "CostApproval_cutoverId_idx" ON "CostApproval"("cutoverId");

-- AddForeignKey (only if it doesn't exist)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CostApproval') THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints 
            WHERE constraint_name = 'CostApproval_productId_fkey'
        ) THEN
            ALTER TABLE "CostApproval" ADD CONSTRAINT "CostApproval_productId_fkey" 
            FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
    END IF;
END $$;

-- AddForeignKey (only if it doesn't exist)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'CutoverLock') THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints 
            WHERE constraint_name = 'CutoverLock_locationId_fkey'
        ) THEN
            ALTER TABLE "CutoverLock" ADD CONSTRAINT "CutoverLock_locationId_fkey" 
            FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
        END IF;
    END IF;
END $$;

