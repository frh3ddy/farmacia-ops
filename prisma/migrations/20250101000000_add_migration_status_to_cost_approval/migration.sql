-- CreateEnum
CREATE TYPE IF NOT EXISTS "MigrationStatus" AS ENUM ('PENDING', 'APPROVED', 'SKIPPED');

-- AlterTable
ALTER TABLE "CostApproval" ADD COLUMN IF NOT EXISTS "migrationStatus" "MigrationStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CostApproval_migrationStatus_idx" ON "CostApproval"("migrationStatus");

