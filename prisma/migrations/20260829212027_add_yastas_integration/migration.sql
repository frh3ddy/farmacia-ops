-- CreateEnum
CREATE TYPE "YastasOperationDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "WalletMovementType" AS ENUM ('OPENING_BALANCE', 'LOAD', 'OPERATION_DEBIT', 'OPERATION_CREDIT', 'TRANSFER_OUT', 'TRANSFER_IN');

-- CreateEnum
CREATE TYPE "YastasSettlementStatus" AS ENUM ('PROVISIONAL', 'CONFIRMED');

-- AlterTable
ALTER TABLE "CatalogMapping" ADD COLUMN     "employeeId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "tracksInventory" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "YastasOperation" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "squareId" TEXT,
    "yastasReceiptRef" TEXT,
    "direction" "YastasOperationDirection" NOT NULL,
    "faceAmount" DECIMAL(65,30) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YastasOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YastasWallet" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "balance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YastasWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletMovement" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletMovementType" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "relatedOperationId" TEXT,
    "relatedTransferId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YastasSettlement" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amountEarned" DECIMAL(65,30) NOT NULL,
    "status" "YastasSettlementStatus" NOT NULL DEFAULT 'PROVISIONAL',
    "reportedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YastasSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YastasWalletTransfer" (
    "id" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YastasWalletTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "YastasOperation_employeeId_idx" ON "YastasOperation"("employeeId");

-- CreateIndex
CREATE INDEX "YastasOperation_locationId_idx" ON "YastasOperation"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "YastasOperation_squareId_key" ON "YastasOperation"("squareId");

-- CreateIndex
CREATE UNIQUE INDEX "YastasWallet_locationId_key" ON "YastasWallet"("locationId");

-- CreateIndex
CREATE INDEX "WalletMovement_walletId_idx" ON "WalletMovement"("walletId");

-- CreateIndex
CREATE INDEX "WalletMovement_relatedOperationId_idx" ON "WalletMovement"("relatedOperationId");

-- CreateIndex
CREATE INDEX "WalletMovement_relatedTransferId_idx" ON "WalletMovement"("relatedTransferId");

-- CreateIndex
CREATE INDEX "YastasSettlement_locationId_idx" ON "YastasSettlement"("locationId");

-- CreateIndex
CREATE INDEX "YastasSettlement_periodStart_periodEnd_idx" ON "YastasSettlement"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "YastasWalletTransfer_fromLocationId_idx" ON "YastasWalletTransfer"("fromLocationId");

-- CreateIndex
CREATE INDEX "YastasWalletTransfer_toLocationId_idx" ON "YastasWalletTransfer"("toLocationId");

-- CreateIndex
CREATE INDEX "CatalogMapping_employeeId_idx" ON "CatalogMapping"("employeeId");

-- AddForeignKey
ALTER TABLE "CatalogMapping" ADD CONSTRAINT "CatalogMapping_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YastasOperation" ADD CONSTRAINT "YastasOperation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YastasOperation" ADD CONSTRAINT "YastasOperation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YastasWallet" ADD CONSTRAINT "YastasWallet_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletMovement" ADD CONSTRAINT "WalletMovement_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "YastasWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletMovement" ADD CONSTRAINT "WalletMovement_relatedOperationId_fkey" FOREIGN KEY ("relatedOperationId") REFERENCES "YastasOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletMovement" ADD CONSTRAINT "WalletMovement_relatedTransferId_fkey" FOREIGN KEY ("relatedTransferId") REFERENCES "YastasWalletTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YastasSettlement" ADD CONSTRAINT "YastasSettlement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YastasWalletTransfer" ADD CONSTRAINT "YastasWalletTransfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YastasWalletTransfer" ADD CONSTRAINT "YastasWalletTransfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YastasWalletTransfer" ADD CONSTRAINT "YastasWalletTransfer_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
