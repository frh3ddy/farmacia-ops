-- Convert Supplier.initials from TEXT to TEXT[]
-- Migrate existing data: single initials become single-element arrays, NULL becomes empty array

-- First, add a new column with the array type
ALTER TABLE "Supplier" ADD COLUMN "initials_new" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Migrate existing data
UPDATE "Supplier" 
SET "initials_new" = CASE 
  WHEN "initials" IS NULL THEN ARRAY[]::TEXT[]
  ELSE ARRAY["initials"]::TEXT[]
END;

-- Drop the old column
ALTER TABLE "Supplier" DROP COLUMN "initials";

-- Rename the new column to the original name
ALTER TABLE "Supplier" RENAME COLUMN "initials_new" TO "initials";

-- Set NOT NULL constraint (arrays can be empty but not null)
ALTER TABLE "Supplier" ALTER COLUMN "initials" SET NOT NULL;

