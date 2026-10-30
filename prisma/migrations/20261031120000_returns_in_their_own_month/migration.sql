-- A return counts in the month it happened: the cash a return by hand paid back,
-- and sales put back to what they sold (returns used to be taken off them).
ALTER TABLE "SaleReturn" ADD COLUMN "cashRefunded" DECIMAL(65,30);

-- Returns made in Square are keyed square-return-line:… or square-refund:…; the rest were by hand.
UPDATE "SaleReturn" SET "cashRefunded" = "revenue" WHERE "clientRequestId" NOT LIKE 'square-%';

UPDATE "Sale" s
SET "totalRevenue" = s."totalRevenue" + r.revenue,
    "totalCost" = s."totalCost" + r.cost,
    "grossProfit" = s."grossProfit" + r.revenue - r.cost
FROM (SELECT "saleId", SUM("revenue") AS revenue, SUM("cost") AS cost FROM "SaleReturn" GROUP BY "saleId") r
WHERE s.id = r."saleId";
