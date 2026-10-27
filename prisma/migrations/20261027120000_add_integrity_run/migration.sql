-- CreateTable
CREATE TABLE "IntegrityRun" (
    "id" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL,
    "mismatchCount" INTEGER NOT NULL,
    "checks" JSONB NOT NULL,

    CONSTRAINT "IntegrityRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrityRun_ranAt_idx" ON "IntegrityRun"("ranAt");
