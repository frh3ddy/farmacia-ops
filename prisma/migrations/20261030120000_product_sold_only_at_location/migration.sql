-- A product sold at one store only (e.g. a single toy): created in Square present
-- at that store alone, and left out of every other store's lists. Null = every store.
ALTER TABLE "Product" ADD COLUMN "soldOnlyAtLocationId" TEXT;

ALTER TABLE "Product" ADD CONSTRAINT "Product_soldOnlyAtLocationId_fkey" FOREIGN KEY ("soldOnlyAtLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
