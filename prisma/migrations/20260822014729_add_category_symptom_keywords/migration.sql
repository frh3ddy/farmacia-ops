-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "symptomKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[];
