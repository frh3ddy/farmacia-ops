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

const CATEGORY_NAMES = [
  'Cuidado/incontinencia adulto',
  'Cuidado infantil',
  'Cuidado femenino',
  'Salud sexual',
  'Primeros auxilios',
  'Recargas/Telecom',
  'Dulces, snacks y bebidas',
  'Nutrición y dietética',
  'Medicina',
  'Dermocosmética',
  'Cuidado capilar e higiene',
  'Accesorio',
  'General/Misceláneos',
  'Sin clasificar',
] as const;

type CategoryName = (typeof CATEGORY_NAMES)[number];

// Order matters: first matching rule wins. More specific buckets (adult diapers, infant care)
// are checked before broader ones (e.g. "pañal" alone) to avoid misclassification.
const RULES: Array<{ category: CategoryName; pattern: RegExp }> = [
  { category: 'Cuidado/incontinencia adulto', pattern: /pa[nñ]al.*adulto|adulto.*pa[nñ]al|incontinencia|comodo\s?plast/i },
  { category: 'Cuidado infantil', pattern: /pa[nñ]al(?!.*adulto)|biber[oó]n|chup[oó]n|f[oó]rmula infantil|bebe|infantil|mordedera/i },
  { category: 'Cuidado femenino', pattern: /kotex|saba\b|toalla femenina|tampon|intima femenina|higiene femenina/i },
  { category: 'Salud sexual', pattern: /cond[oó]n|preservativo|lubricante intimo/i },
  { category: 'Primeros auxilios', pattern: /parche|gasa|curita|venda|algodon|alcohol|agua oxigenada|tela adhesiva|micropore|sutura|cateter|abatelenguas/i },
  { category: 'Recargas/Telecom', pattern: /telcel|movistar|claro\b|tigo\b|chip\b|recarga|tiempo aire/i },
  {
    category: 'Dulces, snacks y bebidas',
    pattern:
      /galleta|chocolate|dulce|gomita|refresco|yoghurt|yogurt|pan dulce|mantecada|gansito|barrita|bonafont|coca[\s-]?cola|redbull|pepsi|sprite\b|fanta\b|gatorade|pingu[ei]nos/i,
  },
  { category: 'Nutrición y dietética', pattern: /vitamina|proteina|fibra|suplemento|colageno|omega[\s-]?3/i },
  {
    category: 'Medicina',
    pattern:
      /\d+\s?(mg|mcg|ml|g)\b|susp\.?\b|iny\.?\b|\btabs?\.?\b|\bcaps?\.?\b|\bsol\.?\b|soluci[oó]n|jarabe|\bgotas\b|comprimido|unguento|ung[uü]ento|cilina\b|prazol\b|[^a-z]azol\b|micina\b|olol\b|statina\b|sartan\b|oxacina\b/i,
  },
  { category: 'Dermocosmética', pattern: /crema|locion|\bgel\b|labial|maquillaje|perfume|colonia|esmalte/i },
  { category: 'Cuidado capilar e higiene', pattern: /shampoo|champu|jabon|talco|pasta dental|cepillo dental|desodorante|papel higienico|acondicionador|tinte/i },
  { category: 'Accesorio', pattern: /jeringa|guante|termometro|prueba( de embarazo)?\b|\btest\b|cepillo|soporte|cubrebocas|mascarilla|aguja/i },
  { category: 'General/Misceláneos', pattern: /juguete|vaso entrenador|regalo/i },
];

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function classifyProductName(rawName: string): CategoryName {
  const name = stripAccents(rawName.toLowerCase());
  for (const rule of RULES) {
    if (rule.pattern.test(name)) return rule.category;
  }
  return 'Sin clasificar';
}

async function ensureCategories(): Promise<Map<CategoryName, string>> {
  const existing = await prisma.category.findMany({ where: { name: { in: [...CATEGORY_NAMES] } } });
  const byName = new Map(existing.map((c) => [c.name as CategoryName, c.id]));

  for (const name of CATEGORY_NAMES) {
    if (!byName.has(name)) {
      const created = await prisma.category.create({ data: { name } });
      byName.set(name, created.id);
    }
  }
  return byName;
}

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

  const categoryIdByName = await ensureCategories();

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
