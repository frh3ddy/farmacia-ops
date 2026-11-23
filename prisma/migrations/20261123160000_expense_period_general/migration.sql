-- D8: the store days an expense covers; reports count it there, not on the
-- day it was paid. Both or neither; existing rows keep counting on their date.
ALTER TABLE "Expense" ADD COLUMN "periodStart" DATE, ADD COLUMN "periodEnd" DATE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_period_check"
  CHECK (("periodStart" IS NULL) = ("periodEnd" IS NULL) AND ("periodEnd" IS NULL OR "periodEnd" >= "periodStart"));
CREATE INDEX "Expense_periodStart_idx" ON "Expense"("periodStart");

-- D9: a general (business-wide) expense has no store.
ALTER TABLE "Expense" ALTER COLUMN "locationId" DROP NOT NULL;
