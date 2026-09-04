/**
 * Pulls the first 5 recognizable medicine products out of the real Square
 * catalog snapshot and writes them out as sample query input for the
 * drug-classification-service (see prompt-drug-classification-service.md) —
 * no API calls, just fixture prep. "Medicine" = name contains a dosage unit
 * (mg/mcg/ml/g/UI/%), which is how a pharmacist would eyeball it too.
 *
 * Also derives a cleaned + Spanish->English/INN-translated search name
 * alongside the raw one -- RxNav/OpenFDA/WHO-ATC are all indexed by English
 * INN names, so a raw Spanish generic name is unlikely to resolve as-is.
 *
 * Usage: npx tsx scripts/generate-drug-classification-test-data.ts
 */
import fs from 'fs';
import path from 'path';
import { MEDICINE_NAME_PATTERN, translateActiveIngredient, spanishActiveIngredient } from './lib/name-translation';

const SNAPSHOT_PATH = path.resolve(__dirname, '../data/square-catalog-snapshot.json');
const OUTPUT_PATH = path.resolve(__dirname, '../data/drug-classification-test-input.json');
const COUNT = 5;

interface SquareItemVariationData {
  sku?: string;
}
interface SquareItemVariation {
  item_variation_data?: SquareItemVariationData;
}
interface SquareItemData {
  name?: string;
  variations?: SquareItemVariation[];
}
interface SquareCatalogItem {
  type: string;
  id: string;
  item_data?: SquareItemData;
}
interface SquareCatalogSnapshot {
  fetchedAt: string;
  itemCount: number;
  items: SquareCatalogItem[];
}

function main() {
  const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf-8');
  const snapshot: SquareCatalogSnapshot = JSON.parse(raw);

  const medicines = snapshot.items.filter((item) =>
    MEDICINE_NAME_PATTERN.test(item.item_data?.name || ''),
  );

  const selected = medicines.slice(0, COUNT).map((item) => {
    const rawName = item.item_data!.name!;
    const sku = item.item_data?.variations?.[0]?.item_variation_data?.sku ?? null;
    return {
      nombre: translateActiveIngredient(rawName), // English/INN -- for RxNav/OpenFDA/ATC lookups only
      nombre_es: spanishActiveIngredient(rawName), // Spanish -- for display (principios_activos)
      nombre_original: rawName,
      barcode: sku,
      sku,
      square_item_id: item.id,
    };
  });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(selected, null, 2) + '\n');

  console.log(`Wrote ${selected.length} test queries to ${path.relative(process.cwd(), OUTPUT_PATH)}\n`);
  console.log(JSON.stringify(selected, null, 2));
}

main();
