/**
 * Classify every Product into a pharmacy-retail category, by name, and fill Product.categoryId.
 *
 * Rule-based (no API calls) — same taxonomy used for the one-off Square catalog categorization
 * pass, turned into a reusable, deterministic classifier so it can run again after every catalog
 * sync / cutover instead of being redone by hand.
 *
 * Usage:
 *   npx tsx scripts/classify-product-categories.ts              # dry run, prints counts only
 *   npx tsx scripts/classify-product-categories.ts --apply       # writes categoryId for products missing one
 *   npx tsx scripts/classify-product-categories.ts --apply --all # reclassify ALL products, including already-categorized ones
 */
import prisma from '../prisma/client';
import { CATEGORY_NAMES, CategoryName, classifyProductName, ensureCategoryIds } from '../apps/api/src/inventory-migration/category-classifier';

async function main() {
  const apply = process.argv.includes('--apply');
  const all = process.argv.includes('--all');

  const products = await prisma.product.findMany({
    where: all ? {} : { categoryId: null },
    select: { id: true, name: true, squareProductName: true },
  });

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — classifying ${products.length} product(s)${all ? ' (all products)' : ' (uncategorized only)'}\n`);

  const counts = new Map<CategoryName, number>();
  const assignments: Array<{ id: string; category: CategoryName }> = [];

  for (const p of products) {
    const category = classifyProductName(p.squareProductName || p.name);
    counts.set(category, (counts.get(category) || 0) + 1);
    assignments.push({ id: p.id, category });
  }

  for (const name of CATEGORY_NAMES) {
    const count = counts.get(name) || 0;
    if (count > 0) console.log(`  ${name.padEnd(30)} ${count}`);
  }

  if (!apply) {
    console.log('\nDry run only — no changes written. Re-run with --apply to write categoryId.');
    await prisma.$disconnect();
    return;
  }

  const categoryIdByName = await ensureCategoryIds(prisma);

  const CHUNK_SIZE = 20;
  let updated = 0;
  for (let i = 0; i < assignments.length; i += CHUNK_SIZE) {
    const chunk = assignments.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map((a) =>
        prisma.product.update({
          where: { id: a.id },
          data: { categoryId: categoryIdByName.get(a.category)! },
        }),
      ),
    );
    updated += chunk.length;
    console.log(`  updated ${updated}/${assignments.length}`);
  }

  console.log(`\nDone — ${updated} product(s) categorized.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
