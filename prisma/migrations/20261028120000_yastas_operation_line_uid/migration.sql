-- One Square payment can hold several Yastás lines; each line is its own
-- operation. Existing rows keep a NULL line uid (NULLs are distinct in a
-- unique index), and redelivery is still checked per payment by the worker.
ALTER TABLE "YastasOperation" ADD COLUMN "squareLineUid" TEXT;

DROP INDEX "YastasOperation_squareId_key";

CREATE UNIQUE INDEX "YastasOperation_squareId_squareLineUid_key" ON "YastasOperation"("squareId", "squareLineUid");
