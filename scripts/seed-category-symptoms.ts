/**
 * Populate Category.symptomKeywords from the curated pharmacy reference data
 * (apps/api/src/products/pharmacy-reference-data.json) so catalog search can
 * match a symptom ("fiebre", "gripa") to the subcategory it belongs to.
 *
 * Idempotent: find-by-name and overwrite, safe to re-run.
 *
 * Usage: npx tsx scripts/seed-category-symptoms.ts
 */
import prisma from '../prisma/client';
import { normalizeSearchAliases } from '../apps/api/src/products/catalog-search';
import referenceData from '../apps/api/src/products/pharmacy-reference-data.json';

async function main() {
  let updated = 0;
  for (const [categoryName, entry] of Object.entries(referenceData)) {
    const category = await prisma.category.findFirst({ where: { name: categoryName } });
    if (!category) {
      console.warn(`No category found named "${categoryName}" — skipping`);
      continue;
    }
    await prisma.category.update({
      where: { id: category.id },
      data: { symptomKeywords: normalizeSearchAliases(entry.sintomas) },
    });
    updated++;
  }
  console.log(`Seeded symptom keywords for ${updated} categories (idempotent — re-run anytime).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
