-- Create ExtractionSession table
CREATE TABLE "ExtractionSession" (
    "id" TEXT NOT NULL,
    "cutoverId" TEXT,
    "locationIds" TEXT[] NOT NULL,
    "currentBatch" INTEGER NOT NULL DEFAULT 1,
    "totalBatches" INTEGER,
    "totalItems" INTEGER NOT NULL,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "batchSize" INTEGER NOT NULL,
    "lastApprovedBatchId" TEXT,
    "lastApprovedProductId" TEXT,
    "learnedSupplierInitials" JSONB,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionSession_pkey" PRIMARY KEY ("id")
);

-- Create ExtractionBatch table
CREATE TABLE "ExtractionBatch" (
    "id" TEXT NOT NULL,
    "extractionSessionId" TEXT NOT NULL,
    "batchNumber" INTEGER NOT NULL,
    "cutoverId" TEXT,
    "locationIds" TEXT[] NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'EXTRACTED',
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "productIds" TEXT[] NOT NULL,
    "totalProducts" INTEGER NOT NULL,
    "productsWithExtraction" INTEGER NOT NULL,
    "productsRequiringManualInput" INTEGER NOT NULL,
    "extractionApproved" BOOLEAN NOT NULL DEFAULT false,
    "manualInputApproved" BOOLEAN NOT NULL DEFAULT false,
    "isFullyApproved" BOOLEAN NOT NULL DEFAULT false,
    "lastApprovedProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionBatch_pkey" PRIMARY KEY ("id")
);

-- Add batchId to CostApproval table
ALTER TABLE "CostApproval" ADD COLUMN "batchId" TEXT;

-- Add foreign key constraints
ALTER TABLE "ExtractionBatch" ADD CONSTRAINT "ExtractionBatch_extractionSessionId_fkey" FOREIGN KEY ("extractionSessionId") REFERENCES "ExtractionSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CostApproval" ADD CONSTRAINT "CostApproval_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ExtractionBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Create indexes
CREATE INDEX "ExtractionSession_cutoverId_idx" ON "ExtractionSession"("cutoverId");
CREATE INDEX "ExtractionSession_status_idx" ON "ExtractionSession"("status");
CREATE INDEX "ExtractionBatch_extractionSessionId_idx" ON "ExtractionBatch"("extractionSessionId");
CREATE INDEX "ExtractionBatch_cutoverId_idx" ON "ExtractionBatch"("cutoverId");
CREATE INDEX "ExtractionBatch_status_idx" ON "ExtractionBatch"("status");
CREATE INDEX "CostApproval_batchId_idx" ON "CostApproval"("batchId");

