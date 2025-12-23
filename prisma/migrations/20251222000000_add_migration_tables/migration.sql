-- AlterTable
ALTER TABLE "Inventory" ADD COLUMN "source" TEXT,
ADD COLUMN "costSource" TEXT,
ADD COLUMN "migrationId" TEXT;

-- CreateTable
CREATE TABLE "CostApproval" (
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

-- CreateTable
CREATE TABLE "Cutover" (
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

-- CreateTable
CREATE TABLE "CutoverLock" (
    "id" TEXT NOT NULL,
    "locationId" TEXT,
    "cutoverDate" TIMESTAMP(3) NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT true,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,

    CONSTRAINT "CutoverLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CostApproval_cutoverId_productId_key" ON "CostApproval"("cutoverId", "productId");

-- CreateIndex
CREATE INDEX "CostApproval_cutoverId_idx" ON "CostApproval"("cutoverId");

-- AddForeignKey
ALTER TABLE "CostApproval" ADD CONSTRAINT "CostApproval_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CutoverLock" ADD CONSTRAINT "CutoverLock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

