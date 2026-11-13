-- Yesterday's closing stock: a product at 0 now that was in stock last night ran out today (stock-alerts O4).
ALTER TABLE "ProductStockStats" ADD COLUMN "stockAtEnd" INTEGER;
