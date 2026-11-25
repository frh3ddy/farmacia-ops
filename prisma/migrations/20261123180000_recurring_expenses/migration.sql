-- D11: recurring expenses (rules; due dates are computed) and payroll per person.
CREATE TYPE "RecurringExpenseKind" AS ENUM ('FIXED', 'VARIES', 'PAYROLL');
CREATE TYPE "RecurringFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'BIMONTHLY', 'YEARLY');
CREATE TYPE "RecurringPeriodRule" AS ENUM ('DUE_MONTH', 'PREVIOUS_MONTH', 'BILL_MONTHS');
CREATE TYPE "PayrollMode" AS ENUM ('HOURS', 'FIXED');

CREATE TABLE "RecurringExpense" (
    "id" TEXT NOT NULL,
    "locationId" TEXT,
    "type" "ExpenseType" NOT NULL,
    "name" TEXT NOT NULL,
    "vendor" TEXT,
    "kind" "RecurringExpenseKind" NOT NULL,
    "amount" DECIMAL(65,30),
    "freq" "RecurringFrequency" NOT NULL,
    "dayOfMonth" INTEGER,
    "weekday" INTEGER,
    "startDate" DATE NOT NULL,
    "periodRule" "RecurringPeriodRule" NOT NULL DEFAULT 'DUE_MONTH',
    "remindDaysBefore" INTEGER,
    "remindTime" TEXT,
    "autoPaid" BOOLEAN NOT NULL DEFAULT false,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RecurringExpense_locationId_idx" ON "RecurringExpense"("locationId");
-- RESTRICT: stores are deactivated, never deleted; SET NULL would turn a store's rent into a general rule.
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PayrollConfig" (
    "teamMemberId" TEXT NOT NULL,
    "included" BOOLEAN NOT NULL DEFAULT true,
    "mode" "PayrollMode" NOT NULL DEFAULT 'HOURS',
    "fixedAmount" DECIMAL(65,30),
    "homeLocationId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollConfig_pkey" PRIMARY KEY ("teamMemberId")
);
ALTER TABLE "PayrollConfig" ADD CONSTRAINT "PayrollConfig_homeLocationId_fkey" FOREIGN KEY ("homeLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The occurrence an expense pays. A non-payroll occurrence is paid once;
-- payroll has one expense per person and store.
ALTER TABLE "Expense" ADD COLUMN "recurringExpenseId" TEXT, ADD COLUMN "occurrenceDate" DATE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_recurringExpenseId_fkey" FOREIGN KEY ("recurringExpenseId") REFERENCES "RecurringExpense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Expense_recurringExpenseId_occurrenceDate_idx" ON "Expense"("recurringExpenseId", "occurrenceDate");
CREATE UNIQUE INDEX "Expense_occurrence_paid_once" ON "Expense"("recurringExpenseId", "occurrenceDate") WHERE "teamMemberId" IS NULL;
