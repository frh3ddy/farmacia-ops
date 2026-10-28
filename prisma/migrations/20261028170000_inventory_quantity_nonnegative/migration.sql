-- Every writer (api adjustments, transfers, break-bulk, the sale worker) is
-- covered: a race that would drive a batch negative fails instead.
-- Prisma doesn't model CHECK constraints, so this lives only in SQL.
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_quantity_nonnegative" CHECK ("quantity" >= 0);
