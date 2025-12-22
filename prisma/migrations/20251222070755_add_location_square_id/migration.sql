-- AlterTable
ALTER TABLE "Location" ADD COLUMN "squareId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Location_squareId_key" ON "Location"("squareId");

