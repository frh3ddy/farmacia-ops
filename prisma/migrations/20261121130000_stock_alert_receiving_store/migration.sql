-- The store a store's supplier orders go through (null: it buys for itself).
ALTER TABLE "StockAlertSettings" ADD COLUMN "receivingLocationId" TEXT;
ALTER TABLE "StockAlertSettings" ADD CONSTRAINT "StockAlertSettings_receivingLocationId_fkey" FOREIGN KEY ("receivingLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Product rows carry stockAlert, which reads coverDays and regularMinWeeks: a
-- change re-sends the store's products that have stats (no stats, no alert).
-- A new row with the defaults changes nothing.
CREATE FUNCTION stock_alert_settings_touch_products() RETURNS trigger AS $$
BEGIN
  PERFORM product_touch(ARRAY(SELECT "productId" FROM "ProductStockStats" WHERE "locationId" = NEW."locationId"));
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER stock_alert_settings_insert_touch_products AFTER INSERT ON "StockAlertSettings"
  FOR EACH ROW WHEN ((NEW."coverDays", NEW."regularMinWeeks") IS DISTINCT FROM (14, 4))
  EXECUTE FUNCTION stock_alert_settings_touch_products();
CREATE TRIGGER stock_alert_settings_update_touch_products AFTER UPDATE ON "StockAlertSettings"
  FOR EACH ROW WHEN ((OLD."coverDays", OLD."regularMinWeeks") IS DISTINCT FROM (NEW."coverDays", NEW."regularMinWeeks"))
  EXECUTE FUNCTION stock_alert_settings_touch_products();
