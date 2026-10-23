-- Typo-tolerant product search (see apps/api/src/products/product-search.ts).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The normalized haystack a product is searched by. Lives in the DB so the
-- index expression and the query expression are literally the same code and
-- cannot drift apart (a mismatch silently loses the index). `translate` is
-- IMMUTABLE and already the accent-stripping idiom used by catalog-search;
-- `concat_ws`/`unaccent` are only STABLE and so are not indexable.
CREATE OR REPLACE FUNCTION product_search_text(name text, square_name text, sku text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT translate(
    lower(name || ' ' || COALESCE(square_name, '') || ' ' || COALESCE(sku, '')),
    'áéíóúñü', 'aeiounu'
  )
$$;

-- gin_trgm_ops serves both the LIKE '%token%' fast path and word_similarity().
CREATE INDEX IF NOT EXISTS "Product_search_trgm_idx"
  ON "Product" USING gin (product_search_text(name, "squareProductName", sku) gin_trgm_ops);
