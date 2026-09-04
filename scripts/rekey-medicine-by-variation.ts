/**
 * Re-key data/medicamentos_procesados_final.json (keyed by Square ITEM id) to
 * Square ITEM_VARIATION id, so the cutover suggestion pipeline can look an
 * entry up by CatalogMapping.squareVariationId (what it already has) with no
 * Product ↔ item-id column.
 *
 * Each item is expanded to every one of its variation ids (pharmacy items are
 * almost always single-variation, but a few aren't). Entries flagged
 * esMedicamento:false are skipped — they'd only fall through to name-only
 * parsing on the API side anyway.
 *
 * Input:  data/medicamentos_procesados_final.json, data/square-catalog-snapshot.json
 * Output: apps/api/src/inventory-migration/medicine-by-variation.json
 *         (co-located so the API can `import` it — same as pharmacy-reference-data.json)
 *
 * Usage:
 *   npx tsx scripts/rekey-medicine-by-variation.ts
 */
import fs from 'fs';
import path from 'path';

type MedicineEntry = {
  name: string;
  esMedicamento: boolean;
  principios_activos: Array<{
    nombre: string;
    dosis: string | null;
    strength: { valor: number | null; unidad: string | null; por: string | null };
  }>;
  formaFarmaceutica: string | null;
  presentacion: string | null;
  marca: string | null;
  laboratorio: string | null;
};

const IN_MEDICINE = path.resolve(__dirname, '../data/medicamentos_procesados_final.json');
const IN_SNAPSHOT = path.resolve(__dirname, '../data/square-catalog-snapshot.json');
const OUT_PATH = path.resolve(__dirname, '../apps/api/src/inventory-migration/medicine-by-variation.json');

function main() {
  const medicine: Record<string, MedicineEntry> = JSON.parse(fs.readFileSync(IN_MEDICINE, 'utf8'));
  const snapshot: { items: Array<{ id: string; item_data?: { variations?: Array<{ id: string }> } }> } = JSON.parse(
    fs.readFileSync(IN_SNAPSHOT, 'utf8'),
  );

  const variationsByItem = new Map<string, string[]>();
  for (const item of snapshot.items) {
    const vids = (item.item_data?.variations ?? []).map((v) => v.id);
    if (vids.length) variationsByItem.set(item.id, vids);
  }

  const byVariation: Record<string, MedicineEntry> = {};
  let matchedItems = 0;
  let matchedVariations = 0;
  let skippedNonMedicine = 0;
  const unmatched: string[] = [];

  for (const [itemId, entry] of Object.entries(medicine)) {
    if (entry.esMedicamento === false) {
      skippedNonMedicine++;
      continue;
    }
    const vids = variationsByItem.get(itemId);
    if (!vids) {
      unmatched.push(itemId);
      continue;
    }
    matchedItems++;
    for (const vid of vids) {
      byVariation[vid] = entry;
      matchedVariations++;
    }
  }

  const sorted = Object.fromEntries(Object.entries(byVariation).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + '\n');

  console.log(`source entries:             ${Object.keys(medicine).length}`);
  console.log(`skipped (esMedicamento=false): ${skippedNonMedicine}`);
  console.log(`items matched in snapshot:  ${matchedItems}`);
  console.log(`variations written:         ${matchedVariations}`);
  console.log(`item ids with no match:     ${unmatched.length}`);
  if (unmatched.length) console.log(unmatched.slice(0, 20).join(', ') + (unmatched.length > 20 ? ' …' : ''));
  console.log(`\nwrote ${path.relative(process.cwd(), OUT_PATH)}`);
}

main();
