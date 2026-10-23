-- Catalog sync used to name new products after the Square variation label
-- ("Regular" / "Sin variación") or its own "Unknown" fallback, while the real
-- item name went to "squareProductName". Copy it over for products still on a
-- placeholder. Exact matches only ("Insulina Regular" is a real name), and
-- never over a manual name. Must stay in sync with isPlaceholderProductName()
-- in apps/api/src/catalog/catalog.service.ts.
UPDATE "Product"
SET "name" = btrim("squareProductName")
WHERE "manualName" IS NULL
  AND lower(btrim("name")) IN ('regular', 'sin variación', 'sin variacion', 'no variation', 'unknown')
  AND btrim(coalesce("squareProductName", '')) <> ''
  AND lower(btrim("squareProductName")) NOT IN ('regular', 'sin variación', 'sin variacion', 'no variation', 'unknown');
