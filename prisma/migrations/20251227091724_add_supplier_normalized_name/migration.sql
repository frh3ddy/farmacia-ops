-- Add normalizedName column (nullable initially)
ALTER TABLE "Supplier" ADD COLUMN "normalizedName" TEXT;

-- Populate normalizedName for existing rows
-- Using a simplified normalization that approximates the JavaScript logic:
-- - Lowercase
-- - Remove non-alphanumeric characters (keeping spaces)
-- - Collapse multiple spaces to single space
-- - Trim
UPDATE "Supplier" 
SET "normalizedName" = TRIM(
  REGEXP_REPLACE(
    REGEXP_REPLACE(
      LOWER("name"),
      '[^a-z0-9\s]', '', 'g'
    ),
    '\s+', ' ', 'g'
  )
);

-- Create unique index on normalizedName
CREATE UNIQUE INDEX "idx_supplier_normalized_name" ON "Supplier" ("normalizedName");

-- Make the column NOT NULL after populating it
ALTER TABLE "Supplier" ALTER COLUMN "normalizedName" SET NOT NULL;
