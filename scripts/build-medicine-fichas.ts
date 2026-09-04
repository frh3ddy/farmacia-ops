/**
 * Assembles a "ficha completa" per catalog medicine, seeded from
 * data/medicine.json (the OCR → Haiku extraction, keyed by Square item id)
 * instead of parsing raw Square catalog names.
 *
 * medicine.json already carries the clean tier-0 fields — principioActivo
 * (ordered, "+"-joined), concentracion, formaFarmaceutica, presentacion,
 * nombreComercial, a Mexican-market laboratorio, plus confianza / notas — so
 * this script only runs the enrichment tiers, and runs them ONCE PER UNIQUE
 * active-ingredient combo (measured: ~1234 non-null entries → ~445 unique)
 * rather than once per product like run-full-catalog-tiers-1-3.ts.
 *
 *   Tier 1  RxNav          rxcui, ATC classes           (lib/rxnav-provider)
 *   Tier 3  local WHO ATC  codigo_atc, jerarquia_atc    (lib/atc-local-provider)
 *   Tier 2  OpenFDA        ndc, upc, US reference lab    (lib/openfda-provider)
 *   Tier 4  Claude Code    registro_sanitario, receta   (lib/claude-code-websearch-provider)
 *           web search     -- OPT-IN via --tier4, per brand, cached
 *
 * Outputs (all in data/):
 *   medicine-fichas.json               object keyed by square_item_id -> Ficha
 *   medicine-fichas.txt                human rendering
 *   medicine-ingredient-enrichment.json  normalized principioActivo -> shared
 *                                        tier-1-3 result; also the resume checkpoint
 *
 * Usage:
 *   npx tsx scripts/build-medicine-fichas.ts                 # tiers 1-3, all medicines
 *   LIMIT=15 npx tsx scripts/build-medicine-fichas.ts        # smoke test: first 15 unique combos
 *   npx tsx scripts/build-medicine-fichas.ts --tier4         # also run the web-search pass
 *   npx tsx scripts/build-medicine-fichas.ts --refresh-enrichment   # ignore the checkpoint
 */
import fs from 'fs';
import path from 'path';
import { translateActiveIngredient } from './lib/name-translation';
import { findRxcui, findAtcClasses, type AtcClass } from './lib/rxnav-provider';
import { loadAtcTable, getAtcHierarchy, searchAtcByName, pickBestLeaf, type AtcHierarchy } from './lib/atc-local-provider';
import { searchOpenFdaByGenericName, type OpenFdaResult } from './lib/openfda-provider';
import { parseStrength, type PrincipioActivo, type Strength } from './lib/square-name-parser';
import { getCategoriaTerapeutica, SIN_CATEGORIA } from './lib/atc-category-mapper';
import { classifyViaClaudeCode } from './lib/claude-code-websearch-provider';

const MEDICINE_PATH = path.resolve(__dirname, '../data/medicine.json');
const SNAPSHOT_PATH = path.resolve(__dirname, '../data/square-catalog-snapshot.json');
const ENRICHMENT_PATH = path.resolve(__dirname, '../data/medicine-ingredient-enrichment.json');
const FICHAS_JSON_PATH = path.resolve(__dirname, '../data/medicine-fichas.json');
const FICHAS_TXT_PATH = path.resolve(__dirname, '../data/medicine-fichas.txt');

const RXNAV_DELAY_MS = 150; // well under RxNav's 20 req/sec limit
const OPENFDA_DELAY_MS = 300; // OpenFDA: 240 req/min without a key
const CHECKPOINT_EVERY = 25;

interface MedicineEntry {
  esMedicamento: boolean;
  confianza: 'alta' | 'media' | 'baja';
  nombreComercial: string | null;
  laboratorio: string | null;
  principioActivo: string | null;
  concentracion: string | null;
  formaFarmaceutica: string | null;
  presentacion: string | null;
  notas: string | null;
}

interface SquareSnapshot {
  items: Array<{ id: string; item_data?: { variations?: Array<{ item_variation_data?: { sku?: string } }> } }>;
}

/** Shared per unique active-ingredient combo — the deduped expensive lookups. */
interface IngredientEnrichment {
  principio_activo_es: string;
  nombre_en: string; // translated INN — the RxNav/OpenFDA/ATC lookup key
  rxcui: string | null;
  codigo_atc: string | null;
  jerarquia_atc: AtcHierarchy | null;
  categoria_terapeutica: string;
  laboratorio_referencia_eeuu: string | null;
  laboratorio_confianza: 'baja' | 'media' | null;
  ndc: string | null;
  upc_barcode: string | null;
  via_administracion: string | null;
  fuentes: string[]; // subset of ['rxnav','atc-local','openfda']
}

interface Ficha {
  square_item_id: string;
  sku: string | null;
  barcode: string | null;
  nombre_original: string; // synthesized display string
  marca: string | null;
  laboratorio: string | null; // Mexican-market, from medicine.json — primary
  laboratorio_referencia_eeuu: string | null; // OpenFDA US labeler — secondary, unverified
  laboratorio_confianza: 'baja' | 'media' | null; // confidence in laboratorio_referencia_eeuu
  registro_sanitario: string | null; // tier 4 only
  requiere_receta: string | null; // tier 4 only
  principios_activos: Array<PrincipioActivo & { strength: Strength | null }>;
  concentracion: string | null; // verbatim product-level string from the OCR
  codigo_atc: string | null;
  jerarquia_atc: AtcHierarchy | null;
  categoria_terapeutica: string;
  rxcui: string | null;
  via_administracion: string | null;
  forma_farmaceutica: string | null;
  envase: string | null;
  ndc: string | null;
  upc_barcode: string | null;
  confianza: 'alta' | 'media' | 'baja'; // medicine.json's own OCR-extraction confidence
  notas: string | null; // OCR caveat, e.g. dose discrepancy — reviewer must check
  fuentes: string[];
  necesita_tier4: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function loadJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/** ponytail: dedup key only — "A + B" and "B + A" would count as two combos.
 * The user confirms medicine.json's ingredient order is correct, so in
 * practice the same combo always arrives as the same string. */
function normKey(principioActivo: string): string {
  return principioActivo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[+/]\s*/g, ' + ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitIngredients(principioActivo: string): string[] {
  return principioActivo
    .split(/\s*[+/]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Best-effort per-ingredient dose split. A single ingredient keeps the whole
 * concentracion string (parseStrength handles "250 mg/5 mL"). A combo only
 * splits when the string breaks into the same count on " - " / " + ";
 * otherwise every ingredient gets a null dose and the whole string stays on
 * the ficha's product-level `concentracion` field. */
function splitConcentracion(concentracion: string | null, count: number): (string | null)[] {
  if (!concentracion || count === 0) return new Array(count).fill(null);
  if (count === 1) return [concentracion.trim()];
  const segs = concentracion
    .split(/\s+[-+]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segs.length === count ? segs : new Array(count).fill(null);
}

function buildPrincipiosActivos(entry: MedicineEntry): Ficha['principios_activos'] {
  const names = entry.principioActivo ? splitIngredients(entry.principioActivo) : [];
  const doses = splitConcentracion(entry.concentracion, names.length);
  return names.map((nombre, i) => ({ nombre, dosis: doses[i], strength: parseStrength(doses[i]) }));
}

function buildDisplayName(e: MedicineEntry): string {
  return [e.nombreComercial, e.principioActivo, e.concentracion, e.formaFarmaceutica, e.presentacion]
    .filter(Boolean)
    .join(' · ');
}

async function enrichCombo(principioActivoEs: string, atcTable: Map<string, string>): Promise<IngredientEnrichment> {
  const nombre_en = translateActiveIngredient(principioActivoEs);
  const fuentes: string[] = [];

  const rxcui = await findRxcui(nombre_en);
  await sleep(RXNAV_DELAY_MS);
  let atcClasses: AtcClass[] = [];
  if (rxcui) {
    fuentes.push('rxnav');
    atcClasses = await findAtcClasses(rxcui);
    await sleep(RXNAV_DELAY_MS);
  }

  const bestLeaf = pickBestLeaf(searchAtcByName(atcTable, nombre_en), atcClasses);
  const jerarquia_atc = bestLeaf ? getAtcHierarchy(atcTable, bestLeaf.codigo) : null;
  if (jerarquia_atc) fuentes.push('atc-local');
  const codigo_atc = bestLeaf?.codigo ?? null;

  let openFda: OpenFdaResult | null = null;
  if (rxcui) {
    openFda = await searchOpenFdaByGenericName(nombre_en);
    await sleep(OPENFDA_DELAY_MS);
    if (openFda) fuentes.push('openfda');
  }

  return {
    principio_activo_es: principioActivoEs,
    nombre_en,
    rxcui,
    codigo_atc,
    jerarquia_atc,
    categoria_terapeutica: getCategoriaTerapeutica(codigo_atc),
    laboratorio_referencia_eeuu: openFda?.laboratorio ?? null,
    laboratorio_confianza: openFda ? (openFda.totalMatches <= 3 ? 'media' : 'baja') : null,
    ndc: openFda?.ndc ?? null,
    upc_barcode: openFda?.upc_barcode ?? null,
    via_administracion: openFda?.route?.[0] ?? null,
    fuentes,
  };
}

async function main() {
  const runTier4 = process.argv.includes('--tier4');
  const refreshEnrichment = process.argv.includes('--refresh-enrichment');
  const limit = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null;

  const medicine: Record<string, MedicineEntry> = JSON.parse(fs.readFileSync(MEDICINE_PATH, 'utf-8'));
  const snapshot: SquareSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
  const atcTable = loadAtcTable();

  const skuByItem = new Map<string, string | null>();
  for (const item of snapshot.items) {
    skuByItem.set(item.id, item.item_data?.variations?.[0]?.item_variation_data?.sku ?? null);
  }

  // Group item ids by unique active-ingredient combo.
  const combos = new Map<string, { principioActivoEs: string; itemIds: string[] }>();
  for (const [itemId, entry] of Object.entries(medicine)) {
    if (!entry.principioActivo) continue;
    const key = normKey(entry.principioActivo);
    if (!combos.has(key)) combos.set(key, { principioActivoEs: entry.principioActivo.trim(), itemIds: [] });
    combos.get(key)!.itemIds.push(itemId);
  }
  const entryCount = Object.keys(medicine).length;
  const nullPa = Object.values(medicine).filter((e) => !e.principioActivo).length;
  console.log(`${entryCount} medicine.json entries (${nullPa} with no principioActivo) → ${combos.size} unique combos`);

  // --- Tiers 1-3: enrich each unique combo once, checkpointed ---
  const enrichment: Record<string, IngredientEnrichment> = refreshEnrichment ? {} : loadJson(ENRICHMENT_PATH, {});
  let comboList = [...combos.entries()];
  if (limit) comboList = comboList.slice(0, limit);
  const emitItemIds: Set<string> | null = limit ? new Set(comboList.flatMap(([, c]) => c.itemIds)) : null;

  let fetched = 0;
  for (let i = 0; i < comboList.length; i++) {
    const [key, { principioActivoEs }] = comboList[i];
    if (enrichment[key] && !refreshEnrichment) continue;
    try {
      enrichment[key] = await enrichCombo(principioActivoEs, atcTable);
      fetched++;
    } catch (err: any) {
      console.error(`  ✗ enrich failed for "${principioActivoEs}": ${err?.message ?? err}`);
    }
    if (fetched > 0 && fetched % CHECKPOINT_EVERY === 0) {
      fs.writeFileSync(ENRICHMENT_PATH, JSON.stringify(enrichment, null, 2) + '\n');
      console.log(`  [${i + 1}/${comboList.length}] checkpoint (${fetched} fetched this run)`);
    }
  }
  fs.writeFileSync(ENRICHMENT_PATH, JSON.stringify(enrichment, null, 2) + '\n');
  console.log(`enrichment: ${Object.keys(enrichment).length} combos cached, ${fetched} fetched this run`);

  // --- Fan out to one ficha per medicine.json item ---
  const fichas: Record<string, Ficha> = {};
  let tier4Calls = 0;
  for (const [itemId, entry] of Object.entries(medicine)) {
    if (emitItemIds && !emitItemIds.has(itemId)) continue;
    const key = entry.principioActivo ? normKey(entry.principioActivo) : null;
    const enr = key ? (enrichment[key] ?? null) : null;
    const sku = skuByItem.get(itemId) ?? null;

    const ficha: Ficha = {
      square_item_id: itemId,
      sku,
      barcode: sku,
      nombre_original: buildDisplayName(entry),
      marca: entry.nombreComercial,
      laboratorio: entry.laboratorio,
      laboratorio_referencia_eeuu: enr?.laboratorio_referencia_eeuu ?? null,
      laboratorio_confianza: enr?.laboratorio_confianza ?? null,
      registro_sanitario: null,
      requiere_receta: null,
      principios_activos: buildPrincipiosActivos(entry),
      concentracion: entry.concentracion,
      codigo_atc: enr?.codigo_atc ?? null,
      jerarquia_atc: enr?.jerarquia_atc ?? null,
      categoria_terapeutica: enr?.categoria_terapeutica ?? SIN_CATEGORIA,
      rxcui: enr?.rxcui ?? null,
      via_administracion: enr?.via_administracion ?? null,
      forma_farmaceutica: entry.formaFarmaceutica,
      envase: entry.presentacion,
      ndc: enr?.ndc ?? null,
      upc_barcode: enr?.upc_barcode ?? null,
      confianza: entry.confianza,
      notas: entry.notas,
      fuentes: ['medicine.json', ...(enr?.fuentes ?? [])],
      necesita_tier4: false,
    };
    // Same rule as run-full-catalog-tiers-1-3.ts: tier 4 is the only path to
    // a classification when tiers 1-3 pinned neither an rxcui nor an ATC code.
    // (registro_sanitario / requiere_receta are always tier-4-only, so they
    // don't factor in here — only in the --tier4 recompute below.)
    ficha.necesita_tier4 = !entry.principioActivo || !ficha.rxcui || !ficha.codigo_atc;

    if (runTier4 && ficha.necesita_tier4) {
      const lookupName = enr?.nombre_en || entry.nombreComercial;
      if (lookupName) {
        try {
          const mx = await classifyViaClaudeCode({ nombre: lookupName, marca: entry.nombreComercial });
          tier4Calls++;
          if (mx) {
            ficha.registro_sanitario = mx.registro_sanitario;
            ficha.requiere_receta = mx.requiere_receta;
            if (mx.laboratorio && !ficha.laboratorio) ficha.laboratorio = mx.laboratorio;
            ficha.codigo_atc = ficha.codigo_atc ?? mx.codigo_atc;
            ficha.via_administracion = ficha.via_administracion ?? mx.via_administracion;
            if (!ficha.forma_farmaceutica) ficha.forma_farmaceutica = mx.forma_farmaceutica;
            if (!ficha.envase) ficha.envase = mx.envase;
            if (mx.principios_activos.length > 0 && ficha.principios_activos.length === 0) {
              ficha.principios_activos = mx.principios_activos.map((p) => ({ ...p, strength: parseStrength(p.dosis) }));
            }
            ficha.categoria_terapeutica = getCategoriaTerapeutica(ficha.codigo_atc);
            ficha.fuentes.push('claude-code-websearch');
            ficha.necesita_tier4 = !ficha.rxcui || !ficha.codigo_atc || !ficha.registro_sanitario;
          }
        } catch (err: any) {
          console.error(`  ✗ tier4 failed for "${entry.nombreComercial}": ${err?.message ?? err}`);
        }
      }
    }

    fichas[itemId] = ficha;
  }

  fs.writeFileSync(FICHAS_JSON_PATH, JSON.stringify(fichas, null, 2) + '\n');
  const txt = Object.values(fichas).map(formatFichaText).join('\n\n' + '-'.repeat(60) + '\n\n');
  fs.writeFileSync(FICHAS_TXT_PATH, txt + '\n');

  const list = Object.values(fichas);
  const resolved = list.filter((f) => f.codigo_atc).length;
  const needsT4 = list.filter((f) => f.necesita_tier4).length;
  console.log(`\n${list.length} fichas written (${resolved} with codigo_atc, ${needsT4} need tier 4${runTier4 ? `, ${tier4Calls} tier-4 calls` : ''})`);
  console.log(`  ${path.relative(process.cwd(), FICHAS_JSON_PATH)}`);
  console.log(`  ${path.relative(process.cwd(), FICHAS_TXT_PATH)}`);
  console.log(`  ${path.relative(process.cwd(), ENRICHMENT_PATH)}`);
}

function formatPrincipiosActivos(principios: Ficha['principios_activos']): string {
  if (principios.length === 0) return '(no disponible)';
  const indent = ' '.repeat(24);
  return principios.map((p) => (p.dosis ? `${p.nombre} (${p.dosis})` : p.nombre)).join(` +\n${indent}`);
}

function formatFichaText(f: Ficha): string {
  const row = (label: string, value: string) => `${(label + ':').padEnd(24)}${value}`;
  const lab = f.laboratorio
    ? f.laboratorio + (f.confianza !== 'alta' ? `  [OCR confianza ${f.confianza}]` : '')
    : f.laboratorio_referencia_eeuu
      ? `${f.laboratorio_referencia_eeuu}  [ref. EE.UU., confianza ${f.laboratorio_confianza ?? 'baja'} — NO verificado]`
      : '(no disponible)';
  const lines = [
    row('Producto', f.nombre_original),
    row('Marca', f.marca ?? '(no disponible)'),
    row('Laboratorio', lab),
    row('Registro sanitario', f.registro_sanitario ?? '(pendiente tier 4)'),
    row('Principios activos', formatPrincipiosActivos(f.principios_activos)),
    row('Concentración', f.concentracion ?? '(no disponible)'),
    row('Código ATC', f.codigo_atc ?? '(no disponible)'),
    row('Categoría terapéutica', f.categoria_terapeutica),
    row('Vía', f.via_administracion ?? '(no disponible)'),
    row('Forma', f.forma_farmaceutica ?? '(no disponible)'),
    row('Envase', f.envase ?? '(no disponible)'),
    row('Requiere receta', f.requiere_receta ?? '(pendiente tier 4)'),
    ...(f.notas ? [row('Nota OCR', f.notas)] : []),
    row('Fuentes', f.fuentes.join(', ')),
  ];
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
