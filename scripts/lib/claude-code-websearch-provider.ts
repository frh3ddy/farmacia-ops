/**
 * Tier 4 of the classification cascade: Mexico-only regulatory fields
 * (registro sanitario, verified laboratorio, requiere receta) that RxNav,
 * OpenFDA, and the WHO ATC CSV structurally cannot provide -- COFEPRIS has
 * no documented public API (checked this session: registros.cofepris.gob.mx
 * is a JS-rendered search UI with no API surface).
 *
 * Shells out to the Claude Code CLI itself in headless mode instead of the
 * raw Messages API -- no separate ANTHROPIC_API_KEY/billing needed, rides
 * the Claude Code auth already active wherever this script runs.
 * `--json-schema` + `--output-format json` gives back a validated object
 * directly on envelope.structured_output (confirmed live in this session --
 * envelope.result is the same data, just JSON-stringified).
 *
 * Usage: import { classifyViaClaudeCode } from './lib/claude-code-websearch-provider'
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import type { PrincipioActivo } from './square-name-parser';

const execFileAsync = promisify(execFile);

const CACHE_PATH = path.resolve(__dirname, '../../data/claude-code-websearch-cache.json');
const MODEL = 'claude-haiku-4-5';
const MAX_BUDGET_USD = '0.50';
const TIMEOUT_MS = 120_000;
const ALLOWED_SITES = ['medicamentosplm.com', 'vademecum.es', 'registros.cofepris.gob.mx'];

export interface MexicoFichaFields {
  laboratorio: string | null;
  registro_sanitario: string | null;
  principios_activos: PrincipioActivo[]; // empty array when none found -- combination products get one entry per active
  codigo_atc: string | null;
  via_administracion: string | null;
  forma_farmaceutica: string | null;
  envase: string | null;
  requiere_receta: string | null;
}

// principios_activos is a nested array-of-objects, everything else is a
// plain nullable string -- schema built by hand instead of the old
// uniform FIELD_KEYS.map loop.
const SIMPLE_FIELD_KEYS: Array<Exclude<keyof MexicoFichaFields, 'principios_activos'>> = [
  'laboratorio',
  'registro_sanitario',
  'codigo_atc',
  'via_administracion',
  'forma_farmaceutica',
  'envase',
  'requiere_receta',
];

const JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    ...Object.fromEntries(SIMPLE_FIELD_KEYS.map((k) => [k, { type: ['string', 'null'] }])),
    principios_activos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          dosis: { type: ['string', 'null'] },
        },
        required: ['nombre', 'dosis'],
      },
    },
  },
  required: [...SIMPLE_FIELD_KEYS, 'principios_activos'],
});

/** Same normalize-then-lowercase idea as atc-local-provider.ts's stripAccents. */
function normalizeCacheKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function loadCache(): Record<string, MexicoFichaFields> {
  if (!fs.existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, MexicoFichaFields>): void {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

function buildPrompt(searchTerm: string): string {
  return (
    `Busca el producto farmacéutico mexicano "${searchTerm}" en ${ALLOWED_SITES.join(', ')}. ` +
    'Devuelve: laboratorio fabricante, número de registro sanitario (COFEPRIS), la lista de ' +
    'principios activos -- un objeto {nombre, dosis} por cada uno si es un producto combinado ' +
    '(ej. dos objetos para un producto con dos sustancias activas, no un solo texto combinado) -- ' +
    'código ATC, vía de administración, forma farmacéutica, descripción del envase, y si requiere ' +
    'receta médica (incluye la fracción si aplica, ej. "Sí (Fracción IV)"). ' +
    'Usa null (o una lista vacía para principios activos) para cualquier campo que no encuentres en ' +
    'esas fuentes -- nunca inventes un dato, especialmente el número de registro sanitario.'
  );
}

/**
 * Returns null (never throws) on any failure -- cache miss + no data is a
 * normal, expected outcome for this tier, same as every other provider in
 * this pipeline degrading gracefully instead of failing the whole ficha.
 */
export async function classifyViaClaudeCode(query: {
  nombre: string;
  marca?: string | null;
}): Promise<MexicoFichaFields | null> {
  const searchTerm = query.marca?.trim() || query.nombre;
  const cacheKey = normalizeCacheKey(searchTerm);

  const cache = loadCache();
  if (cache[cacheKey]) {
    return cache[cacheKey];
  }

  let stdout: string;
  try {
    const result = await execFileAsync(
      'claude',
      [
        '-p',
        buildPrompt(searchTerm),
        '--model',
        MODEL,
        '--output-format',
        'json',
        '--json-schema',
        JSON_SCHEMA,
        '--allowedTools',
        'WebSearch',
        'WebFetch',
        '--max-budget-usd',
        MAX_BUDGET_USD,
        '--no-session-persistence',
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: TIMEOUT_MS },
    );
    stdout = result.stdout;
  } catch (err: any) {
    // execFile's error object carries stdout/stderr from the failed child
    // process -- err.message alone is often just "Command failed: <argv>",
    // useless for diagnosing why.
    console.error(`[claude-code-websearch] subprocess failed for "${searchTerm}":`, err?.message ?? err);
    if (err?.stderr) console.error('  stderr:', err.stderr);
    if (err?.stdout) console.error('  stdout:', err.stdout);
    return null;
  }

  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    console.error(`[claude-code-websearch] failed to parse envelope JSON for "${searchTerm}". Raw stdout:`, stdout);
    return null;
  }

  if (envelope.is_error) {
    console.error(`[claude-code-websearch] CLI reported an error for "${searchTerm}":`, envelope.result ?? envelope);
    return null;
  }

  const fields = envelope.structured_output;
  if (!fields || typeof fields !== 'object') {
    console.error(`[claude-code-websearch] no structured_output for "${searchTerm}". Full envelope:`, JSON.stringify(envelope, null, 2));
    return null;
  }

  const parsed: MexicoFichaFields = {
    laboratorio: fields.laboratorio ?? null,
    registro_sanitario: fields.registro_sanitario ?? null,
    principios_activos: Array.isArray(fields.principios_activos) ? fields.principios_activos : [],
    codigo_atc: fields.codigo_atc ?? null,
    via_administracion: fields.via_administracion ?? null,
    forma_farmaceutica: fields.forma_farmaceutica ?? null,
    envase: fields.envase ?? null,
    requiere_receta: fields.requiere_receta ?? null,
  };

  cache[cacheKey] = parsed;
  saveCache(cache);

  return parsed;
}
