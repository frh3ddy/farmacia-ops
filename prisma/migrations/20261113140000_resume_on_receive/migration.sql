-- A paused product resumes by itself when its store receives it (stock-alerts O5):
-- a receiving, or a transfer line pointed at the batch it created, whatever the
-- stock was. Adjustments, counts and returns create neither, so they never resume.
-- A trigger, like the product change stamps, so no write path can skip it.
CREATE FUNCTION product_store_status_resume_on_receive() RETURNS trigger AS $$
DECLARE
  store text;
  product text;
BEGIN
  IF TG_TABLE_NAME = 'InventoryReceiving' THEN
    store := NEW."locationId";
    product := NEW."productId";
  ELSE
    SELECT "locationId", "productId" INTO store, product FROM "Inventory" WHERE id = NEW."destinationInventoryId";
  END IF;
  UPDATE "ProductStoreStatus"
     SET "pausedAt" = NULL,
         "resumedAt" = now() AT TIME ZONE 'UTC', -- the columns hold UTC without a zone, like Prisma writes them
         "resumeCause" = 'STOCK_RECEIVED',
         "resumedByEmployeeId" = NULL
   WHERE "productId" = product AND "locationId" = store AND "pausedAt" IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_receiving_resume_paused AFTER INSERT ON "InventoryReceiving"
  FOR EACH ROW EXECUTE FUNCTION product_store_status_resume_on_receive();

-- A line gets its destination batch when the transfer is received (TransferService.receiveIn).
-- Only a line newly pointed at a batch is a delivery: writing the same batch again isn't.
CREATE TRIGGER transfer_line_insert_resume_paused AFTER INSERT ON "TransferLine"
  FOR EACH ROW WHEN (NEW."destinationInventoryId" IS NOT NULL)
  EXECUTE FUNCTION product_store_status_resume_on_receive();
CREATE TRIGGER transfer_line_update_resume_paused AFTER UPDATE OF "destinationInventoryId" ON "TransferLine"
  FOR EACH ROW WHEN (NEW."destinationInventoryId" IS NOT NULL AND NEW."destinationInventoryId" IS DISTINCT FROM OLD."destinationInventoryId")
  EXECUTE FUNCTION product_store_status_resume_on_receive();
