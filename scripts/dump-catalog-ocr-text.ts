/**
 * Local-only OCR dump for the full Square catalog. Recognizes text from every
 * product's catalog image (offline PP-OCRv6 via @arcships/light-ocr, no API
 * calls) and writes one row per catalog item, keyed by the Square identifiers,
 * so a later pass (e.g. a Haiku name/ingredient extractor) can iterate on the
 * text offline.
 *
 * Reads nothing from the DB and writes nothing to it — the Square snapshot is
 * the only product source. `data/square-catalog-snapshot.json` has image *ids*
 * but no URLs; `data/catalog-image-urls.json` (built separately, by resolving
 * those ids through the Square catalog API) supplies the URLs.
 *
 * Note: @arcships/light-ocr supports Node 22/24 only; its native addon is
 * skipped on other versions (this repo's dev machine runs Node 25). Run under
 * `nvm use 24` (or 22). Same constraint as scripts/ocr-classify-products.ts.
 *
 * Resumable: re-running skips items that already have OCR text (or a terminal
 * no-image / image-unresolved status) in the existing output file.
 *
 * Usage:
 *   nvm use 24 && npx tsx scripts/dump-catalog-ocr-text.ts
 *   nvm use 24 && LIMIT=20 npx tsx scripts/dump-catalog-ocr-text.ts   # smoke test
 */
import fs from 'fs';
import path from 'path';
import { createEngine, type OcrEngine } from '@arcships/light-ocr';

const SNAPSHOT_PATH = path.resolve(__dirname, '../data/square-catalog-snapshot.json');
const IMAGE_URLS_PATH = path.resolve(__dirname, '../data/catalog-image-urls.json');
const OUT_PATH = path.resolve(__dirname, '../data/catalog-ocr-text.json');
const CHECKPOINT_EVERY = 50;
const DOWNLOAD_DELAY_MS = 50; // courtesy gap between S3 image fetches

type Source = 'ocr' | 'ocr-failed' | 'no-image' | 'image-unresolved';

interface OcrRow {
  squareItemId: string;
  squareVariationId: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  imageId: string | null;
  squareImageUrl: string | null;
  ocrText: string | null;
  source: Source;
}

interface SquareVariation {
  id?: string;
  item_variation_data?: { sku?: string; upc?: string };
}
interface SquareItem {
  id: string;
  item_data?: { name?: string; image_ids?: string[]; variations?: SquareVariation[] };
}
interface Snapshot {
  items: SquareItem[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isEanLike = (s: string | null | undefined): s is string => !!s && /^\d{12,14}$/.test(s);

async function ocrImage(engine: OcrEngine, url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const result = await engine.recognizeEncoded(bytes);
  return result.lines.map((l) => l.text).join('\n');
}

function isDone(row: OcrRow | undefined): boolean {
  return !!row && (row.ocrText != null || row.source === 'no-image' || row.source === 'image-unresolved');
}

async function main() {
  const snapshot: Snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));

  const urlMap: Record<string, string> = fs.existsSync(IMAGE_URLS_PATH)
    ? JSON.parse(fs.readFileSync(IMAGE_URLS_PATH, 'utf-8'))
    : {};
  if (Object.keys(urlMap).length === 0) {
    console.warn(`No image URLs found at ${path.relative(process.cwd(), IMAGE_URLS_PATH)} — every imaged item will be "image-unresolved".`);
  }

  // Resume from any prior run.
  const byItemId = new Map<string, OcrRow>();
  if (fs.existsSync(OUT_PATH)) {
    const prior: OcrRow[] = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
    for (const row of prior) byItemId.set(row.squareItemId, row);
    console.log(`Resuming — ${prior.length} rows already in ${path.relative(process.cwd(), OUT_PATH)}`);
  }

  let items = snapshot.items;
  if (process.env.LIMIT) items = items.slice(0, parseInt(process.env.LIMIT, 10));
  console.log(`${items.length} catalog items to process\n`);

  let engine: OcrEngine;
  try {
    engine = await createEngine();
  } catch (e) {
    console.error(`\n  ${(e as Error).message}`);
    console.error("  Run under 'nvm use 24' — the light-ocr native addon isn't available on this Node.\n");
    process.exit(1);
  }

  const flush = () => {
    const rows = [...byItemId.values()];
    fs.writeFileSync(OUT_PATH, JSON.stringify(rows, null, 2) + '\n');
  };

  let processed = 0;
  let ocred = 0;
  let failed = 0;
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (isDone(byItemId.get(item.id))) continue;

      const data = item.item_data ?? {};
      const variation = data.variations?.[0];
      const v = variation?.item_variation_data;
      const sku = v?.sku ?? null;
      const imageId = data.image_ids?.[0] ?? null;

      let squareImageUrl: string | null = null;
      let ocrText: string | null = null;
      let source: Source;

      if (!imageId) {
        source = 'no-image';
      } else if (!(imageId in urlMap)) {
        source = 'image-unresolved';
      } else {
        squareImageUrl = urlMap[imageId];
        try {
          ocrText = await ocrImage(engine, squareImageUrl);
          source = 'ocr';
          ocred++;
        } catch (e) {
          source = 'ocr-failed';
          failed++;
          console.error(`  ✗ OCR failed for "${data.name ?? item.id}": ${(e as Error).message}`);
        }
        await sleep(DOWNLOAD_DELAY_MS);
      }

      byItemId.set(item.id, {
        squareItemId: item.id,
        squareVariationId: variation?.id ?? null,
        name: data.name ?? '',
        sku,
        barcode: v?.upc ?? (isEanLike(sku) ? sku : null),
        imageId,
        squareImageUrl,
        ocrText,
        source,
      });

      processed++;
      if (processed % CHECKPOINT_EVERY === 0) {
        flush();
        console.log(`  [${i + 1}/${items.length}] checkpoint (${ocred} ocr, ${failed} failed)`);
      }
    }
  } finally {
    flush();
    await engine.close();
  }

  const counts: Record<Source, number> = { ocr: 0, 'ocr-failed': 0, 'no-image': 0, 'image-unresolved': 0 };
  for (const row of byItemId.values()) counts[row.source]++;

  console.log(`\nDone. ${byItemId.size} rows written to ${path.relative(process.cwd(), OUT_PATH)}`);
  console.log('By source:');
  for (const [k, n] of Object.entries(counts)) console.log(`  ${k.padEnd(18)} ${n}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
