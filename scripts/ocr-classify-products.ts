/**
 * OCR-first product classification: recognizes text from each product's
 * Square catalog image (Product.squareImageUrl) via @arcships/light-ocr
 * (offline PP-OCRv6, no API calls), classifies that text with the same
 * rule-based classifyProductName() used by classify-product-categories.ts,
 * and falls back to the product's own name when there's no image, the OCR
 * text doesn't match a category, or OCR fails outright.
 *
 * Processes every product (not just uncategorized ones) since OCR text is
 * often the only source that has the printed active-ingredient/product info
 * a brand-only Square name lacks.
 *
 * Note: @arcships/light-ocr declares support for Node 22/24 only. Its native
 * runtime packages (darwin-arm64, linux-x64-gnu — see root package.json's
 * optionalDependencies) are legitimately optional: npm skips whichever one
 * doesn't match the current OS/CPU, same as any platform-specific native
 * dependency. A local Node that doesn't satisfy the engines range (e.g. this
 * repo's dev machine on Node 25) additionally skips whichever one WOULD
 * match the platform too — that's a real local-only gap (this script won't
 * find the addon there), not something to work around by forcing a platform
 * package into `dependencies` again: that previously broke the prod build,
 * since it force-installs the wrong platform's native binary everywhere
 * (Railway's Linux x64 container tried to install the darwin-arm64 one and
 * hard-failed with EBADPLATFORM). Use `nvm use 24` (or 22) locally instead
 * when you need to actually run this script.
 *
 * Caches recognized text on Product.ocrText so this (and the cutover
 * extraction flow, which prefers this cached text for ingredient parsing)
 * never re-OCRs an image already processed — only products with no cached
 * text get a fresh OCR pass.
 *
 * Usage:
 *   npx tsx scripts/ocr-classify-products.ts           # dry run, prints per-product source + counts
 *   npx tsx scripts/ocr-classify-products.ts --apply    # writes categoryId + ocrText
 */
import prisma from '../prisma/client';
import { createEngine, type OcrEngine } from '@arcships/light-ocr';
import {
  CATEGORY_NAMES,
  CategoryName,
  classifyProductName,
  ensureCategoryIds,
} from '../apps/api/src/inventory-migration/category-classifier';

type Source = 'ocr' | 'name-fallback' | 'no-image';

async function ocrText(engine: OcrEngine, url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const result = await engine.recognizeEncoded(bytes);
  return result.lines.map((l) => l.text).join('\n');
}

async function main() {
  const apply = process.argv.includes('--apply');

  const products = await prisma.product.findMany({
    select: { id: true, name: true, squareProductName: true, squareImageUrl: true, ocrText: true },
  });

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — OCR-classifying ${products.length} product(s)\n`);

  const engine = await createEngine();
  const categoryCounts = new Map<CategoryName, number>();
  const sourceCounts: Record<Source, number> = { ocr: 0, 'name-fallback': 0, 'no-image': 0 };
  const assignments: Array<{ id: string; category: CategoryName; ocrText: string | null }> = [];

  try {
    for (const p of products) {
      const fallbackName = p.squareProductName || p.name;
      let category: CategoryName;
      let source: Source;
      let text: string | null = p.ocrText; // reuse cached OCR text if this product was already processed
      let ocrSnippet = '';

      if (text) {
        ocrSnippet = text.replace(/\s+/g, ' ').slice(0, 80);
      } else if (p.squareImageUrl) {
        try {
          text = await ocrText(engine, p.squareImageUrl);
          ocrSnippet = text.replace(/\s+/g, ' ').slice(0, 80);
        } catch (e) {
          console.error(`  OCR failed for "${fallbackName}": ${(e as Error).message}`);
          text = null;
        }
      }

      if (text) {
        const ocrCategory = classifyProductName(text);
        if (ocrCategory !== 'Sin clasificar') {
          category = ocrCategory;
          source = 'ocr';
        } else {
          category = classifyProductName(fallbackName);
          source = 'name-fallback';
        }
      } else {
        category = classifyProductName(fallbackName);
        source = p.squareImageUrl ? 'name-fallback' : 'no-image';
      }

      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      sourceCounts[source]++;
      assignments.push({ id: p.id, category, ocrText: text });

      console.log(
        `  [${source.padEnd(13)}] ${fallbackName.slice(0, 40).padEnd(40)} -> ${category}` +
          (ocrSnippet ? `  (ocr: "${ocrSnippet}")` : ''),
      );
    }
  } finally {
    await engine.close();
  }

  console.log('\nBy category:');
  for (const name of CATEGORY_NAMES) {
    const count = categoryCounts.get(name) || 0;
    if (count > 0) console.log(`  ${name.padEnd(30)} ${count}`);
  }

  console.log('\nBy source:');
  console.log(`  ocr           ${sourceCounts.ocr}`);
  console.log(`  name-fallback ${sourceCounts['name-fallback']}`);
  console.log(`  no-image      ${sourceCounts['no-image']}`);

  if (!apply) {
    console.log('\nDry run only — no changes written. Re-run with --apply to write categoryId + ocrText.');
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
          data: { categoryId: categoryIdByName.get(a.category)!, ocrText: a.ocrText },
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
