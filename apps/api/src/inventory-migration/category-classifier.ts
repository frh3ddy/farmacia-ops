/**
 * Rule-based (no API calls) product-category classifier by name, shared
 * between the cutover extraction flow and the standalone
 * scripts/classify-product-categories.ts maintenance script.
 */
import { PrismaClient } from '@prisma/client';

export const CATEGORY_NAMES = [
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

export type CategoryName = (typeof CATEGORY_NAMES)[number];

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

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function classifyProductName(rawName: string): CategoryName {
  const name = stripAccents(rawName.toLowerCase());
  for (const rule of RULES) {
    if (rule.pattern.test(name)) return rule.category;
  }
  return 'Sin clasificar';
}

// Where each classifier bucket actually lives in the admin taxonomy (see
// scripts/seed-category-hierarchy.ts). Every bucket maps onto an existing
// admin category — none of them create a new top-level row, even where the
// fit is imperfect (Recargas/Telecom, Dulces/snacks/bebidas, Accesorio, Sin
// clasificar all fold into the closest existing catch-all).
const TARGET_CATEGORY: Record<CategoryName, { name: string; parentName: string | null }> = {
  'Cuidado/incontinencia adulto': { name: 'Adultos mayores', parentName: null },
  'Cuidado infantil': { name: 'Bebés y maternidad', parentName: null },
  'Cuidado femenino': { name: 'Higiene y cuidado personal', parentName: null },
  'Salud sexual': { name: 'Salud sexual', parentName: null },
  'Primeros auxilios': { name: 'Material de curación', parentName: null },
  'Recargas/Telecom': { name: 'Productos diversos', parentName: null },
  'Dulces, snacks y bebidas': { name: 'Productos diversos', parentName: null },
  'Nutrición y dietética': { name: 'Vitaminas, suplementos y nutrición', parentName: null },
  Medicina: { name: 'Medicamentos', parentName: null },
  Dermocosmética: { name: 'Cuidado de la piel', parentName: null },
  'Cuidado capilar e higiene': { name: 'Higiene y cuidado personal', parentName: null },
  Accesorio: { name: 'Material de curación', parentName: null },
  'General/Misceláneos': { name: 'Productos diversos', parentName: null },
  'Sin clasificar': { name: 'Productos diversos', parentName: null },
};

async function findOrCreateCategory(
  prisma: PrismaClient,
  name: string,
  parentId: string | null,
): Promise<string> {
  const existing = await prisma.category.findFirst({ where: { name, parentId } });
  if (existing) return existing.id;
  const created = await prisma.category.create({ data: { name, parentId } });
  return created.id;
}

/**
 * Resolve each classifier bucket to its real Category row — in the shared
 * admin taxonomy where one exists, matched by (name, parentId) so this never
 * collides with a same-named subcategory or re-creates a row that's already
 * there. Returns a bucket-name -> id map, same as before.
 */
export async function ensureCategoryIds(prisma: PrismaClient): Promise<Map<CategoryName, string>> {
  const byName = new Map<CategoryName, string>();
  const parentIdCache = new Map<string, string>();

  for (const bucket of CATEGORY_NAMES) {
    const target = TARGET_CATEGORY[bucket];
    let parentId: string | null = null;
    if (target.parentName) {
      parentId = parentIdCache.get(target.parentName) ?? null;
      if (!parentId) {
        parentId = await findOrCreateCategory(prisma, target.parentName, null);
        parentIdCache.set(target.parentName, parentId);
      }
    }
    byName.set(bucket, await findOrCreateCategory(prisma, target.name, parentId));
  }
  return byName;
}

export type CategoryRow = { id: string; name: string; parentId: string | null };

const SUBCATEGORY_STOPWORDS = new Set(['y', 'de', 'del', 'la', 'el', 'los', 'las', 'para', 'en', 'con', 'a', 'al', 'o', 'u', 'sin']);

function stemSpanishWord(word: string): string {
  // Deliberately just strips a trailing "s" (e.g. "guantes" -> "guante",
  // "curitas" -> "curita") rather than trying to also unwind "-es" plurals
  // ("irritaciones" -> "irritacion"): guessing wrong there ("guantes" would
  // wrongly become "guant") is worse than the safe failure mode of an
  // occasional missed match on a consonant-final plural.
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Words derived from a subcategory's own name, used as literal keywords —
// e.g. "Cremas para manos" -> ["crema", "mano"]. No hand-curated rules.
function subcategoryKeywords(name: string): string[] {
  return stripAccents(name.toLowerCase())
    .split(/[\s,/()]+/)
    .filter((w) => w.length > 2 && !SUBCATEGORY_STOPWORDS.has(w))
    .map(stemSpanishWord);
}

/**
 * Guesses a subcategory for a product name from candidate subcategories'
 * own names (typically the children of whichever top-level category
 * classifyProductName already picked) — no hand-curated rules, unlike the
 * top-level RULES. Requires every significant word derived from a
 * subcategory's name to appear (as a whole word) in the product name, and
 * only returns a match when exactly one subcategory qualifies; ambiguous
 * (multiple matches) or no matches both return null rather than guess wrong.
 */
export function classifySubcategory(productName: string, subcategories: CategoryRow[]): CategoryRow | null {
  const normalizedProduct = stripAccents(productName.toLowerCase());
  const matches: CategoryRow[] = [];

  for (const sub of subcategories) {
    const keywords = subcategoryKeywords(sub.name);
    if (keywords.length === 0) continue;
    const allPresent = keywords.every((kw) => new RegExp(`\\b${escapeRegex(kw)}`, 'i').test(normalizedProduct));
    if (allPresent) matches.push(sub);
  }

  return matches.length === 1 ? matches[0] : null;
}
