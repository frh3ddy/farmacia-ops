-- Product rows now carry stockAlert.lastSoldAt, so a nightly run that moves
-- only the last sale (a sale in, another out of the window) must re-send the
-- product too, or the phones keep the old "última venta".
-- stockAtEnd stays out: it only changes when the stock moved, and a stock
-- change already re-sends the product. computedAt stays out too (it changes on
-- every row every night). ponytail: so a product that runs out between midnight
-- and the run shows its stock-out date as unknown on the phones until its next
-- change or the next night; touch on the run's day change if that matters.
DROP TRIGGER product_stock_stats_update_touch_product ON "ProductStockStats";
CREATE TRIGGER product_stock_stats_update_touch_product AFTER UPDATE ON "ProductStockStats"
  FOR EACH ROW WHEN (
    (OLD."windowDays", OLD."unitsSold", OLD."weeksWithSales", OLD."typicalOnHand", OLD."zeroSince", OLD."lastSoldAt")
    IS DISTINCT FROM (NEW."windowDays", NEW."unitsSold", NEW."weeksWithSales", NEW."typicalOnHand", NEW."zeroSince", NEW."lastSoldAt")
  ) EXECUTE FUNCTION product_touch_from_child();
