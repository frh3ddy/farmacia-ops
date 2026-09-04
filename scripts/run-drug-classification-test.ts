/**
 * Runs the 5 test queries from data/drug-classification-test-input.json
 * through step 1+2 of the RxNav cascade described in
 * prompt-drug-classification-service.md's "RxNav Provider" section:
 *   1. GET /rxcui.json?name={drugName}&search=2       -> RxCUI
 *   2. GET /rxclass/class/byRxcui.json?rxcui=...&relaSource=ATC -> ATC class
 *
 * This is a validation runner, not the classification service itself:
 * RxNav needs no API key so it's the cheapest way to check whether the
 * cleaned-up names actually resolve before building the full cascade
 * (OpenFDA fallback, local ATC-CSV hierarchy lookup, caching, the
 * ATC->categoria_terapeutica mapping). It reports whatever ATC class code
 * RxNav hands back directly -- it does NOT reconstruct the full 5-level
 * jerarquia_atc breakdown (nivel1..nivel5) from the spec's DrugClassification
 * interface; that needs the local WHO ATC CSV, which is a separate,
 * not-yet-built piece.
 *
 * Usage: npx tsx scripts/run-drug-classification-test.ts
 */
import fs from 'fs';
import path from 'path';
import { findRxcui, findAtcClasses, type AtcClass } from './lib/rxnav-provider';

const INPUT_PATH = path.resolve(__dirname, '../data/drug-classification-test-input.json');
const OUTPUT_PATH = path.resolve(__dirname, '../data/drug-classification-test-results.json');
const REQUEST_DELAY_MS = 150; // well under RxNav's 20 req/sec limit

interface TestQuery {
  nombre: string;
  nombre_es: string;
  nombre_original: string;
  barcode: string | null;
  sku: string | null;
  square_item_id: string;
}

interface ClassificationResult extends TestQuery {
  rxcui: string | null;
  atcClasses: AtcClass[];
  resolved: boolean;
  fallbackNeeded: string | null; // per the doc's own cascade: what to try next if RxNav comes up empty
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function classifyOne(query: TestQuery): Promise<ClassificationResult> {
  const rxcui = await findRxcui(query.nombre);
  await sleep(REQUEST_DELAY_MS);

  if (!rxcui) {
    return {
      ...query,
      rxcui: null,
      atcClasses: [],
      resolved: false,
      fallbackNeeded: 'OpenFDA (brand/generic name search), then ATC local by partial name',
    };
  }

  const atcClasses = await findAtcClasses(rxcui);
  await sleep(REQUEST_DELAY_MS);

  return {
    ...query,
    rxcui,
    atcClasses,
    resolved: atcClasses.length > 0,
    fallbackNeeded: atcClasses.length > 0 ? null : 'OpenFDA / ATC local (RxCUI found but no ATC class)',
  };
}

async function main() {
  const queries: TestQuery[] = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));

  const results: ClassificationResult[] = [];
  for (const query of queries) {
    console.log(`Querying RxNav for "${query.nombre}" (from "${query.nombre_original}")...`);
    const result = await classifyOne(query);
    results.push(result);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2) + '\n');

  console.log(`\nWrote ${results.length} results to ${path.relative(process.cwd(), OUTPUT_PATH)}\n`);
  console.log('Summary:');
  for (const r of results) {
    if (r.resolved) {
      const classes = r.atcClasses.map((c) => `${c.classId} (${c.className})`).join(', ');
      console.log(`  ✓ ${r.nombre} -> rxcui=${r.rxcui}, ATC: ${classes}`);
    } else if (r.rxcui) {
      console.log(`  ~ ${r.nombre} -> rxcui=${r.rxcui}, no ATC class found. Fallback: ${r.fallbackNeeded}`);
    } else {
      console.log(`  ✗ ${r.nombre} -> not found in RxNav. Fallback: ${r.fallbackNeeded}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
