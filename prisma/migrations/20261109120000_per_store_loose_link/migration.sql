-- A box's suelto moves from one link shared by every store (Product.looseProductId)
-- to one row per store, so each store can pair the box with its own suelto.

-- CreateTable
CREATE TABLE "ProductLooseLink" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "boxProductId" TEXT NOT NULL,
    "looseProductId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductLooseLink_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductLooseLink_locationId_looseProductId_idx" ON "ProductLooseLink"("locationId", "looseProductId");
CREATE UNIQUE INDEX "ProductLooseLink_locationId_boxProductId_key" ON "ProductLooseLink"("locationId", "boxProductId");

ALTER TABLE "ProductLooseLink" ADD CONSTRAINT "ProductLooseLink_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductLooseLink" ADD CONSTRAINT "ProductLooseLink_boxProductId_fkey" FOREIGN KEY ("boxProductId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductLooseLink" ADD CONSTRAINT "ProductLooseLink_looseProductId_fkey" FOREIGN KEY ("looseProductId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A link change is a change to the box's product row (its looseProductId), so
-- the phone's product sync resends the box (product_change_stamp migration).
CREATE FUNCTION loose_link_touch_box() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM product_touch(ARRAY[NEW."boxProductId"]);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM product_touch(ARRAY[OLD."boxProductId"]);
  ELSE
    PERFORM product_touch(ARRAY[OLD."boxProductId", NEW."boxProductId"]);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER loose_link_touch_box AFTER INSERT OR UPDATE OR DELETE ON "ProductLooseLink"
  FOR EACH ROW EXECUTE FUNCTION loose_link_touch_box();

-- Every store where both the box and its suelto are sold keeps today's link.
INSERT INTO "ProductLooseLink" ("id", "locationId", "boxProductId", "looseProductId")
SELECT gen_random_uuid()::text, l.id, b.id, b."looseProductId"
FROM "Product" b
JOIN "Product" s ON s.id = b."looseProductId"
CROSS JOIN "Location" l
WHERE (b."soldOnlyAtLocationId" IS NULL OR b."soldOnlyAtLocationId" = l.id)
  AND (s."soldOnlyAtLocationId" IS NULL OR s."soldOnlyAtLocationId" = l.id);

-- A store that loses the link (it doesn't sell both) must resend the box too.
SELECT product_touch(ARRAY(SELECT id FROM "Product" WHERE "looseProductId" IS NOT NULL));

ALTER TABLE "Product" DROP CONSTRAINT "Product_looseProductId_fkey";
ALTER TABLE "Product" DROP COLUMN "looseProductId";
