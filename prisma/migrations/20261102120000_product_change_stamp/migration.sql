-- Each product carries the id of the transaction that last changed what the
-- product list shows of it (the row, its batches, its price links, its
-- category, the stores it's linked at), so the phone can sync only what
-- changed. Triggers, not app code: sales take stock off batches with raw SQL,
-- which Prisma's @updatedAt never sees. A deleted product leaves a removal mark.

ALTER TABLE "Product" ADD COLUMN "changeXid" xid8 NOT NULL DEFAULT '0';
CREATE INDEX "Product_changeXid_id_idx" ON "Product" ("changeXid", "id");

CREATE TABLE "ProductRemoval" (
    "productId" TEXT NOT NULL,
    "changeXid" xid8 NOT NULL DEFAULT '0',
    CONSTRAINT "ProductRemoval_pkey" PRIMARY KEY ("productId")
);
CREATE INDEX "ProductRemoval_changeXid_productId_idx" ON "ProductRemoval" ("changeXid", "productId");

CREATE FUNCTION product_stamp() RETURNS trigger AS $$
BEGIN
  NEW."changeXid" := pg_current_xact_id();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER product_stamp BEFORE INSERT OR UPDATE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION product_stamp();

-- Touching a product re-runs product_stamp; one already stamped by this
-- transaction is left alone, so a sale over many batches writes it once.
CREATE FUNCTION product_touch(ids TEXT[]) RETURNS void AS $$
  UPDATE "Product" SET "changeXid" = pg_current_xact_id()
  WHERE id = ANY(ids) AND "changeXid" <> pg_current_xact_id();
$$ LANGUAGE sql;

CREATE FUNCTION product_touch_from_child() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM product_touch(ARRAY[NEW."productId"]);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM product_touch(ARRAY[OLD."productId"]);
  ELSE
    PERFORM product_touch(ARRAY[OLD."productId", NEW."productId"]);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_touch_product AFTER INSERT OR UPDATE OR DELETE ON "Inventory"
  FOR EACH ROW EXECUTE FUNCTION product_touch_from_child();
CREATE TRIGGER catalog_mapping_touch_product AFTER INSERT OR UPDATE OR DELETE ON "CatalogMapping"
  FOR EACH ROW EXECUTE FUNCTION product_touch_from_child();

-- Only a real change: the store sync from Square re-saves every store each run.
CREATE FUNCTION category_touch_products() RETURNS trigger AS $$
BEGIN
  PERFORM product_touch(ARRAY(SELECT id FROM "Product" WHERE "categoryId" = NEW.id));
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER category_touch_products AFTER UPDATE ON "Category"
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION category_touch_products();

CREATE FUNCTION location_touch_products() RETURNS trigger AS $$
BEGIN
  PERFORM product_touch(ARRAY(SELECT "productId" FROM "CatalogMapping" WHERE "locationId" = NEW.id));
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER location_touch_products AFTER UPDATE ON "Location"
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION location_touch_products();

CREATE FUNCTION product_mark_removal() RETURNS trigger AS $$
BEGIN
  INSERT INTO "ProductRemoval" ("productId", "changeXid") VALUES (OLD.id, pg_current_xact_id())
  ON CONFLICT ("productId") DO UPDATE SET "changeXid" = EXCLUDED."changeXid";
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER product_mark_removal AFTER DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION product_mark_removal();
