/**
 * Assembles the final "ficha completa" for the 5 test products, combining
 * every source built so far:
 *   - RxNav (rxcui, name resolution)               -- run-drug-classification-test.ts
 *   - Local WHO ATC CSV (codigo_atc, jerarquia_atc) -- run-atc-hierarchy-lookup.ts
 *   - OpenFDA (laboratorio, ndc, upc_barcode)       -- lib/openfda-provider.ts
 *   - Raw Square catalog name (marca, dosis,        -- lib/square-name-parser.ts
 *     via_administracion, forma_farmaceutica, envase)
 *   - Claude Code headless (registro_sanitario,      -- lib/claude-code-websearch-provider.ts
 *     requiere_receta, verified laboratorio) via web search against PLM/
 *     Vademecum/COFEPRIS -- the tier COFEPRIS's undocumented-API gap forced;
 *     see that file's header for why the CLI instead of the raw Messages API.
 *
 * Usage: npx tsx scripts/build-drug-ficha.ts
 */
import fs from 'fs';
import path from 'path';
import { searchOpenFdaByGenericName, type OpenFdaResult } from './lib/openfda-provider';
import { parseSquareName, extractPrincipiosActivos, parseStrength, type PrincipioActivo, type Strength } from './lib/square-name-parser';
import { getCategoriaTerapeutica, SIN_CATEGORIA } from './lib/atc-category-mapper';
import { classifyViaClaudeCode } from './lib/claude-code-websearch-provider';
import type { AtcHierarchy } from './lib/atc-local-provider';

const INPUT_PATH = path.resolve(__dirname, '../data/drug-classification-test-results-with-hierarchy.json');
const OUTPUT_JSON_PATH = path.resolve(__dirname, '../data/drug-classification-fichas.json');
const OUTPUT_TEXT_PATH = path.resolve(__dirname, '../data/drug-classification-fichas.txt');
const REQUEST_DELAY_MS = 300; // OpenFDA: 240 req/min without a key

interface HierarchyResult {
  nombre: string;
  nombre_es: string;
  nombre_original: string;
  barcode: string | null;
  sku: string | null;
  square_item_id: string;
  rxcui: string | null;
  resolved: boolean;
  codigo_atc: string | null;
  jerarquia_atc: AtcHierarchy | null;
}

interface Ficha {
  marca: string | null;
  // NOT a verified manufacturer for this specific product -- see
  // OpenFdaResult's doc comment. laboratorio_confianza flags how much
  // weight to give it (an unverified single-manufacturer generic vs. one
  // arbitrary pick among hundreds).
  laboratorio_referencia_eeuu: string | null;
  laboratorio_confianza: 'baja' | 'media' | 'alta' | null; // 'alta' = product-specific source (tier 4), not an arbitrary generic-name match
  registro_sanitario: string | null; // tier 4 only -- COFEPRIS has no documented API otherwise
  principios_activos: Array<PrincipioActivo & { strength: Strength | null }>;
  codigo_atc: string | null;
  jerarquia_atc: AtcHierarchy | null;
  categoria_terapeutica: string; // subcategoria in our Category hierarchy, once wired up
  via_administracion: string | null;
  forma_farmaceutica: string | null;
  envase: string | null;
  ndc: string | null;
  upc_barcode: string | null;
  requiere_receta: string | null; // tier 4 only -- same reason as registro_sanitario
  fuentes: string[];
  // traceability, not part of the ficha itself
  sku: string | null;
  square_item_id: string;
  nombre_original: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attach a parsed strength to each ingredient without losing the original nombre/dosis. */
function withStrength(list: PrincipioActivo[]): Ficha['principios_activos'] {
  return list.map((p) => ({ ...p, strength: parseStrength(p.dosis) }));
}

async function buildFicha(result: HierarchyResult): Promise<Ficha> {
  const parsed = parseSquareName(result.nombre_original);
  const principios_activos = withStrength(extractPrincipiosActivos(result.nombre_original));

  let openFda: OpenFdaResult | null = null;
  if (result.resolved) {
    openFda = await searchOpenFdaByGenericName(result.nombre);
    await sleep(REQUEST_DELAY_MS);
  }

  const fuentes = ['square-catalog'];
  if (result.rxcui) fuentes.push('rxnav');
  if (result.jerarquia_atc) fuentes.push('atc-local');
  if (openFda) fuentes.push('openfda');

  const ficha: Ficha = {
    marca: parsed.marca,
    laboratorio_referencia_eeuu: openFda?.laboratorio ?? null,
    // <=3 matches: plausibly a less-generic product, first hit more likely
    // representative. Otherwise (the common case) it's one arbitrary pick
    // among many unrelated manufacturers -- low confidence, don't trust it.
    laboratorio_confianza: openFda ? (openFda.totalMatches <= 3 ? 'media' : 'baja') : null,
    registro_sanitario: null,
    principios_activos,
    codigo_atc: result.codigo_atc,
    jerarquia_atc: result.jerarquia_atc,
    categoria_terapeutica: SIN_CATEGORIA, // recomputed below once tier 4 has had a chance to fill codigo_atc
    via_administracion: parsed.via_administracion ?? (openFda?.route?.[0] ?? null),
    forma_farmaceutica: parsed.forma_farmaceutica ?? (openFda?.dosage_form ?? null),
    envase: parsed.envase,
    ndc: openFda?.ndc ?? null,
    upc_barcode: openFda?.upc_barcode ?? null,
    requiere_receta: null,
    fuentes,
    sku: result.sku,
    square_item_id: result.square_item_id,
    nombre_original: result.nombre_original,
  };

  // Tier 4: registro_sanitario/requiere_receta only ever come from here.
  // laboratorio/codigo_atc/via/forma/envase are filled only where tiers 1-3
  // left a gap -- a working RxNav/ATC-local/Square-parse answer for an
  // international generic isn't discarded in favor of a web-search guess.
  const mx = await classifyViaClaudeCode({ nombre: result.nombre, marca: parsed.marca });
  if (mx) {
    ficha.registro_sanitario = mx.registro_sanitario;
    ficha.requiere_receta = mx.requiere_receta;
    if (mx.laboratorio) {
      ficha.laboratorio_referencia_eeuu = mx.laboratorio;
      ficha.laboratorio_confianza = 'alta';
    }
    ficha.codigo_atc = ficha.codigo_atc ?? mx.codigo_atc;
    ficha.via_administracion = ficha.via_administracion ?? mx.via_administracion;
    ficha.forma_farmaceutica = ficha.forma_farmaceutica ?? mx.forma_farmaceutica;
    ficha.envase = ficha.envase ?? mx.envase;
    // Product-specific web search beats a raw-name regex guess, especially
    // for combination products -- but don't discard a working Square-name
    // parse for an empty tier-4 miss.
    if (mx.principios_activos.length > 0) {
      ficha.principios_activos = withStrength(mx.principios_activos);
    }
    ficha.fuentes.push('claude-code-websearch');
  }

  ficha.categoria_terapeutica = getCategoriaTerapeutica(ficha.codigo_atc);

  return ficha;
}

/** "Nombre (dosis) +\n<indent>Nombre2 (dosis2)" -- one line per ingredient, matching the reference ficha's style. */
function formatPrincipiosActivos(principios: Ficha['principios_activos']): string {
  if (principios.length === 0) return '(no disponible)';
  const indent = ' '.repeat(24);
  return principios
    .map((p) => (p.dosis ? `${p.nombre} (${p.dosis})` : p.nombre))
    .join(` +\n${indent}`);
}

function formatFichaText(f: Ficha): string {
  const row = (label: string, value: string) => `${(label + ':').padEnd(24)}${value}`;
  const labResult = !f.laboratorio_referencia_eeuu
    ? '(no disponible)'
    : f.laboratorio_confianza === 'alta'
      ? f.laboratorio_referencia_eeuu // verified via product-specific web search (tier 4) -- no caveat needed
      : `${f.laboratorio_referencia_eeuu}  [ref. EE.UU., confianza ${f.laboratorio_confianza} -- NO verificado, no es el fabricante real de este producto]`;
  const lines = [
    row('Marca', f.marca ?? '(no disponible)'),
    row('Laboratorio', labResult),
    row('Registro sanitario', f.registro_sanitario ?? '(no encontrado en PLM/Vademecum/COFEPRIS)'),
    row('Principios activos', formatPrincipiosActivos(f.principios_activos)),
    row('Código ATC', f.codigo_atc ?? '(no disponible)'),
    row('Categoría terapéutica', f.categoria_terapeutica),
    row('Vía', f.via_administracion ?? '(no disponible)'),
    row('Forma', f.forma_farmaceutica ?? '(no disponible)'),
    row('Envase', f.envase ?? '(no disponible)'),
    row('Requiere receta', f.requiere_receta ?? '(no encontrado en PLM/Vademecum/COFEPRIS)'),
    row('Fuentes', f.fuentes.join(', ')),
  ];
  return lines.join('\n');
}

async function main() {
  const results: HierarchyResult[] = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));

  const fichas: Ficha[] = [];
  for (const result of results) {
    console.log(`Building ficha for ${result.nombre}...`);
    fichas.push(await buildFicha(result));
  }

  fs.writeFileSync(OUTPUT_JSON_PATH, JSON.stringify(fichas, null, 2) + '\n');

  const textOutput = fichas.map(formatFichaText).join('\n\n' + '-'.repeat(60) + '\n\n');
  fs.writeFileSync(OUTPUT_TEXT_PATH, textOutput + '\n');

  console.log(`\nWrote ${fichas.length} fichas to:`);
  console.log(`  ${path.relative(process.cwd(), OUTPUT_JSON_PATH)}`);
  console.log(`  ${path.relative(process.cwd(), OUTPUT_TEXT_PATH)}\n`);
  console.log(textOutput);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
