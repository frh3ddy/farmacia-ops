-- D10: a payroll expense names the Square team member paid.
ALTER TABLE "Expense" ADD COLUMN "teamMemberId" TEXT;
CREATE INDEX "Expense_teamMemberId_idx" ON "Expense"("teamMemberId");
