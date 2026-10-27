-- CreateTable
CREATE TABLE "UnmatchedSaleLine" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "squareLineUid" TEXT,
    "description" TEXT,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnmatchedSaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedSaleLine_saleId_squareLineUid_key" ON "UnmatchedSaleLine"("saleId", "squareLineUid");

-- AddForeignKey
ALTER TABLE "UnmatchedSaleLine" ADD CONSTRAINT "UnmatchedSaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
