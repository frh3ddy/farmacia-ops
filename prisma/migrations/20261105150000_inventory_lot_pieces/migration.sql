-- A lot piece split off a batch by a Conteo inicial: where it came from and the
-- units it started with, so the books check and the expiring list can follow it.
ALTER TABLE "Inventory" ADD COLUMN "splitFromId" TEXT, ADD COLUMN "splitInitialQuantity" INTEGER;
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_splitFromId_fkey" FOREIGN KEY ("splitFromId") REFERENCES "Inventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
