-- A product sold at one store only (e.g. a single toy) is created in Square present at that store alone.
ALTER TABLE "Product" ADD COLUMN "soldAtAllLocations" BOOLEAN NOT NULL DEFAULT true;
