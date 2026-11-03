-- The box's barcode, from Square's item variation `upc`. Not unique: Square
-- allows two variations the same barcode, and the scanner shows both.
ALTER TABLE "Product" ADD COLUMN "gtin" TEXT;

CREATE INDEX "Product_gtin_idx" ON "Product"("gtin");
