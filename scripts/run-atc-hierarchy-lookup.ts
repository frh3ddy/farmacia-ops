/**
 * Completes the jerarquia_atc (nivel1..nivel5) for each of the 5 test items
 * already resolved against RxNav (data/drug-classification-test-results.json,
 * produced by run-drug-classification-test.ts) using the local WHO ATC-DDD
 * CSV — this is step "4. Si viene código ATC -> ATC local para la jerarquía"
 * from prompt-drug-classification-service.md's resolution cascade, minus
 * the RxNav/OpenFDA "complementar con productos específicos" part.
 *
 * Disambiguation: several ingredient names have more than one ATC leaf code
 * (e.g. "acetylsalicylic acid" appears under A01AD, B01AC, and N02BA — it's
 * genuinely used for different indications). Where RxNav already gave us
 * ATC1-4 class codes for the rxcui, prefer the leaf whose code falls under
 * one of those classes; otherwise take the first exact name match.
 *
 * Usage: npx tsx scripts/run-atc-hierarchy-lookup.ts
 */
import fs from 'fs';
import path from 'path';
import { loadAtcTable, getAtcHierarchy, searchAtcByName, pickBestLeaf, type AtcHierarchy } from './lib/atc-local-provider';

const INPUT_PATH = path.resolve(__dirname, '../data/drug-classification-test-results.json');
const OUTPUT_PATH = path.resolve(__dirname, '../data/drug-classification-test-results-with-hierarchy.json');

interface RxNavResult {
  nombre: string;
  nombre_es: string;
  nombre_original: string;
  barcode: string | null;
  sku: string | null;
  square_item_id: string;
  rxcui: string | null;
  atcClasses: Array<{ classId: string; className: string }>;
  resolved: boolean;
  fallbackNeeded: string | null;
}

interface HierarchyResult extends RxNavResult {
  codigo_atc: string | null;
  jerarquia_atc: AtcHierarchy | null;
  otrosCodigosCandidatos: string[]; // other level-5 matches found, if any, for visibility
}

function main() {
  const results: RxNavResult[] = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const table = loadAtcTable();
  console.log(`Loaded ${table.size} ATC entries from the local WHO CSV.\n`);

  const augmented: HierarchyResult[] = results.map((r) => {
    if (!r.resolved) {
      return { ...r, codigo_atc: null, jerarquia_atc: null, otrosCodigosCandidatos: [] };
    }

    const candidates = searchAtcByName(table, r.nombre);
    const best = pickBestLeaf(candidates, r.atcClasses);
    const jerarquia_atc = best ? getAtcHierarchy(table, best.codigo) : null;

    return {
      ...r,
      codigo_atc: best?.codigo ?? null,
      jerarquia_atc,
      otrosCodigosCandidatos: candidates.filter((c) => c.codigo !== best?.codigo).map((c) => c.codigo),
    };
  });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(augmented, null, 2) + '\n');
  console.log(`Wrote ${augmented.length} results to ${path.relative(process.cwd(), OUTPUT_PATH)}\n`);

  console.log('Summary:');
  for (const r of augmented) {
    if (!r.jerarquia_atc) {
      console.log(`  ✗ ${r.nombre} -> no ATC hierarchy resolved`);
      continue;
    }
    const h = r.jerarquia_atc;
    console.log(`  ✓ ${r.nombre} -> ${r.codigo_atc}`);
    console.log(`      nivel1: ${h.nivel1.codigo} - ${h.nivel1.nombre}`);
    console.log(`      nivel2: ${h.nivel2.codigo} - ${h.nivel2.nombre}`);
    console.log(`      nivel3: ${h.nivel3.codigo} - ${h.nivel3.nombre}`);
    console.log(`      nivel4: ${h.nivel4.codigo} - ${h.nivel4.nombre}`);
    console.log(`      nivel5: ${h.nivel5.codigo} - ${h.nivel5.nombre}`);
    if (r.otrosCodigosCandidatos.length > 0) {
      console.log(`      (other candidate codes for this name: ${r.otrosCodigosCandidatos.join(', ')})`);
    }
  }
}

main();
