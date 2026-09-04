/**
 * Runs tiers 1-3 of the classification cascade (RxNav, local WHO ATC CSV,
 * OpenFDA, Square-name parse) against every "medicine" item in the full
 * Square catalog snapshot -- not just the fixed 5-item test set. Tier 4
 * (Claude Code web search -- registro_sanitario, verified laboratorio,
 * requiere_receta) is deliberately NOT run here: it's gated by the Claude
 * Code CLI's own daily session usage cap (confirmed empirically -- ~5 calls
 * exhausted it), so it isn't viable to run against ~1,900 products in one
 * sitting. Instead, every item gets a `necesita_tier4` flag:
 *
 *   necesita_tier4 = true  when tiers 1-3 produced NO real clinical
 *   classification at all -- RxNav never resolved (no rxcui) OR resolved
 *   but no codigo_atc could be pinned down (RxNav class + local ATC search
 *   both came up empty). These are the products where tier 4 isn't just
 *   polish (registro_sanitario) -- it's the only way to get any
 *   categoria_terapeutica/codigo_atc at all.
 *
 * Writes two files:
 *   - drug-classification-full-catalog.json   -- every matched product
 *   - drug-classification-needs-tier4.json    -- just the flagged subset,
 *     minimal fields, ready as input to a future batched tier-4 runner
 *
 * Usage: npx tsx scripts/run-full-catalog-tiers-1-3.ts
 */
import fs from 'fs';
import path from 'path';
import { translateActiveIngredient, spanishActiveIngredient } from './lib/name-translation';
import { classifyProductName } from '../apps/api/src/inventory-migration/category-classifier';
import { findRxcui, findAtcClasses, type AtcClass } from './lib/rxnav-provider';
import { loadAtcTable, getAtcHierarchy, searchAtcByName, pickBestLeaf, type AtcHierarchy } from './lib/atc-local-provider';
import { searchOpenFdaByGenericName, type OpenFdaResult } from './lib/openfda-provider';
import { parseSquareName, extractPrincipiosActivos, parseStrength, type PrincipioActivo, type Strength } from './lib/square-name-parser';
import { getCategoriaTerapeutica, SIN_CATEGORIA } from './lib/atc-category-mapper';

const SNAPSHOT_PATH = path.resolve(__dirname, '../data/square-catalog-snapshot.json');
const OUTPUT_PATH = path.resolve(__dirname, '../data/drug-classification-full-catalog.json');
const NEEDS_TIER4_PATH = path.resolve(__dirname, '../data/drug-classification-needs-tier4.json');
const RXNAV_DELAY_MS = 150; // well under RxNav's 20 req/sec limit
const OPENFDA_DELAY_MS = 300; // OpenFDA: 240 req/min without a key
const CHECKPOINT_EVERY = 50; // flush partial results periodically -- a ~1,900-item run is long enough that a crash shouldn't lose everything

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

interface CatalogFicha {
  nombre: string; // English/INN, used for the lookups
  nombre_es: string;
  nombre_original: string;
  barcode: string | null;
  sku: string | null;
  square_item_id: string;
  marca: string | null;
  laboratorio_referencia_eeuu: string | null;
  laboratorio_confianza: 'baja' | 'media' | null; // tier 4 ('alta') never runs here
  registro_sanitario: null; // tier 4 only
  principios_activos: Array<PrincipioActivo & { strength: Strength | null }>;
  rxcui: string | null;
  codigo_atc: string | null;
  jerarquia_atc: AtcHierarchy | null;
  categoria_terapeutica: string;
  via_administracion: string | null;
  forma_farmaceutica: string | null;
  envase: string | null;
  ndc: string | null;
  upc_barcode: string | null;
  requiere_receta: null; // tier 4 only
  fuentes: string[];
  necesita_tier4: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildCatalogFicha(item: SquareCatalogItem, atcTable: Map<string, string>): Promise<CatalogFicha> {
  const rawName = item.item_data!.name!;
  const sku = item.item_data?.variations?.[0]?.item_variation_data?.sku ?? null;
  const nombre = translateActiveIngredient(rawName);
  const nombre_es = spanishActiveIngredient(rawName);
  const parsed = parseSquareName(rawName);
  const principios_activos = extractPrincipiosActivos(rawName).map((p) => ({ ...p, strength: parseStrength(p.dosis) }));

  const fuentes = ['square-catalog'];

  // Tier 1: RxNav
  const rxcui = await findRxcui(nombre);
  await sleep(RXNAV_DELAY_MS);
  let atcClasses: AtcClass[] = [];
  if (rxcui) {
    fuentes.push('rxnav');
    atcClasses = await findAtcClasses(rxcui);
    await sleep(RXNAV_DELAY_MS);
  }

  // Tier 3 (local ATC CSV) -- only meaningful once we have a name to search by
  const candidates = searchAtcByName(atcTable, nombre);
  const bestLeaf = pickBestLeaf(candidates, atcClasses);
  const jerarquia_atc = bestLeaf ? getAtcHierarchy(atcTable, bestLeaf.codigo) : null;
  if (jerarquia_atc) fuentes.push('atc-local');
  const codigo_atc = bestLeaf?.codigo ?? null;

  // Tier 2: OpenFDA -- only worth trying once RxNav has confirmed the name resolves to something real
  let openFda: OpenFdaResult | null = null;
  if (rxcui) {
    openFda = await searchOpenFdaByGenericName(nombre);
    await sleep(OPENFDA_DELAY_MS);
    if (openFda) fuentes.push('openfda');
  }

  return {
    nombre,
    nombre_es,
    nombre_original: rawName,
    barcode: sku,
    sku,
    square_item_id: item.id,
    marca: parsed.marca,
    laboratorio_referencia_eeuu: openFda?.laboratorio ?? null,
    laboratorio_confianza: openFda ? (openFda.totalMatches <= 3 ? 'media' : 'baja') : null,
    registro_sanitario: null,
    principios_activos,
    rxcui,
    codigo_atc,
    jerarquia_atc,
    categoria_terapeutica: getCategoriaTerapeutica(codigo_atc),
    via_administracion: parsed.via_administracion ?? (openFda?.route?.[0] ?? null),
    forma_farmaceutica: parsed.forma_farmaceutica ?? (openFda?.dosage_form ?? null),
    envase: parsed.envase,
    ndc: openFda?.ndc ?? null,
    upc_barcode: openFda?.upc_barcode ?? null,
    requiere_receta: null,
    fuentes,
    // No rxcui, or a rxcui with no ATC code found anywhere (RxNav class or
    // local CSV name search) -- tiers 1-3 gave no real classification at
    // all, so tier 4 isn't polish here, it's the only path to one.
    necesita_tier4: !rxcui || !codigo_atc,
  };
}

async function main() {
  const snapshot: SquareCatalogSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
  let medicines = snapshot.items.filter((item) => classifyProductName(item.item_data?.name || '') === 'Medicina');
  console.log(`${medicines.length} of ${snapshot.items.length} catalog items classify as Medicina by name.\n`);
  if (process.env.LIMIT) medicines = medicines.slice(0, parseInt(process.env.LIMIT, 10)); // LIMIT=20 npx tsx ... for a quick smoke test

  const atcTable = loadAtcTable();
  console.log(`Loaded ${atcTable.size} ATC entries from the local WHO CSV.\n`);

  const results: CatalogFicha[] = [];
  let errors = 0;
  for (let i = 0; i < medicines.length; i++) {
    const item = medicines[i];
    try {
      const ficha = await buildCatalogFicha(item, atcTable);
      results.push(ficha);
    } catch (err: any) {
      // One bad item (network hiccup, unexpected shape) shouldn't sink a
      // ~1,900-item run -- log and move on, same graceful-degrade convention
      // as every other provider in this pipeline.
      errors++;
      console.error(`  ✗ [${i + 1}/${medicines.length}] failed on "${item.item_data?.name}":`, err?.message ?? err);
    }

    if ((i + 1) % CHECKPOINT_EVERY === 0 || i === medicines.length - 1) {
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2) + '\n');
      const needsTier4Count = results.filter((r) => r.necesita_tier4).length;
      console.log(
        `[${i + 1}/${medicines.length}] checkpoint written (${results.length} ok, ${errors} failed, ${needsTier4Count} need tier 4)`,
      );
    }
  }

  const needsTier4 = results
    .filter((r) => r.necesita_tier4)
    .map((r) => ({
      nombre: r.nombre,
      nombre_es: r.nombre_es,
      nombre_original: r.nombre_original,
      marca: r.marca,
      barcode: r.barcode,
      sku: r.sku,
      square_item_id: r.square_item_id,
    }));
  fs.writeFileSync(NEEDS_TIER4_PATH, JSON.stringify(needsTier4, null, 2) + '\n');

  console.log(`\nDone. ${results.length} products classified (${errors} failed), ${needsTier4.length} flagged as needing tier 4.`);
  console.log(`  ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log(`  ${path.relative(process.cwd(), NEEDS_TIER4_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
