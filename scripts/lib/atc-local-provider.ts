/**
 * ATC Local Provider — the offline fallback described in
 * prompt-drug-classification-service.md's "3. ATC Local Provider" section.
 *
 * The doc's suggested URL (WHO ATC-DDD 2024-12-16.csv) 404s — the repo
 * (github.com/fabkury/atcd) has moved on to newer dated files. Vendored the
 * current one (WHO ATC-DDD 2026-04-25.csv) into data/ instead of fetching
 * it over the network at runtime: the whole point of a "local"/offline
 * fallback provider is to not depend on GitHub being reachable when RxNav
 * and OpenFDA already aren't.
 *
 * WHO ATC codes are fixed-width, hierarchical by construction, so a flat
 * code->name Map plus prefix-slicing IS the "hierarchical tree" the doc
 * asks for — no need for actual nested node objects:
 *   nivel1 = code[0:1]  (e.g. "J")        — anatomical main group
 *   nivel2 = code[0:3]  (e.g. "J01")      — therapeutic subgroup
 *   nivel3 = code[0:4]  (e.g. "J01C")     — pharmacological subgroup
 *   nivel4 = code[0:5]  (e.g. "J01CA")    — chemical subgroup
 *   nivel5 = code[0:7]  (e.g. "J01CA04")  — chemical substance (leaf)
 */
import fs from 'fs';
import path from 'path';

export const DEFAULT_ATC_CSV_PATH = path.resolve(__dirname, '../../data/who-atc-ddd-2026-04-25.csv');

const LEVEL_LENGTHS = [1, 3, 4, 5, 7] as const;

export interface AtcEntry {
  codigo: string;
  nombre: string;
}

export interface AtcHierarchy {
  nivel1: AtcEntry;
  nivel2: AtcEntry;
  nivel3: AtcEntry;
  nivel4: AtcEntry;
  nivel5: AtcEntry;
}

/** Minimal RFC4180-ish CSV line splitter — handles quoted fields with embedded commas/quotes. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** code -> name, first occurrence wins (the CSV repeats a code once per DDD/route row). */
export function loadAtcTable(csvPath: string = DEFAULT_ATC_CSV_PATH): Map<string, string> {
  const lines = fs.readFileSync(csvPath, 'utf-8').split('\n');
  const table = new Map<string, string>();
  // header: atc_code,atc_name,ddd,uom,adm_r,note
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const [code, name] = parseCsvLine(line);
    if (code && name && !table.has(code)) {
      table.set(code, name);
    }
  }
  return table;
}

/**
 * Given a full level-5 (7-char) ATC code, slice out the standard prefixes
 * and look up each level's name. Returns null if the code is shorter than
 * 7 chars (not a leaf/substance code) or any level is missing from the table.
 */
export function getAtcHierarchy(table: Map<string, string>, fullCode: string): AtcHierarchy | null {
  if (fullCode.length < 7) return null;

  const levels = LEVEL_LENGTHS.map((len) => {
    const codigo = fullCode.slice(0, len);
    const nombre = table.get(codigo);
    return nombre ? { codigo, nombre } : null;
  });

  if (levels.some((l) => l === null)) return null;

  const [nivel1, nivel2, nivel3, nivel4, nivel5] = levels as AtcEntry[];
  return { nivel1, nivel2, nivel3, nivel4, nivel5 };
}

/**
 * Search level-5 (substance-leaf) entries by name — case-insensitive.
 * Exact matches are returned first, then partial/substring matches
 * ("nombre parcial del principio activo" per the doc), each sorted by code
 * so results are stable.
 */
export function searchAtcByName(table: Map<string, string>, query: string): AtcEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const exact: AtcEntry[] = [];
  const partial: AtcEntry[] = [];

  for (const [codigo, nombre] of table.entries()) {
    if (codigo.length !== 7) continue; // only substance-level leaves are meaningful drug names
    const haystack = nombre.toLowerCase();
    if (haystack === needle) {
      exact.push({ codigo, nombre });
    } else if (haystack.includes(needle)) {
      partial.push({ codigo, nombre });
    }
  }

  const byCode = (a: AtcEntry, b: AtcEntry) => a.codigo.localeCompare(b.codigo);
  return [...exact.sort(byCode), ...partial.sort(byCode)];
}

/**
 * Pick which searchAtcByName() candidate to use when a name has more than
 * one ATC leaf (e.g. "acetylsalicylic acid" appears under A01AD, B01AC, and
 * N02BA -- it's genuinely used for different indications). Walk RxNav's own
 * returned class order (not the alphabetically-sorted candidate list) -- a
 * multi-indication ingredient's "first" class is a real, inherent ambiguity,
 * so respecting RxNav's order is the best signal available, not a guarantee
 * of the "most clinically relevant" one.
 */
export function pickBestLeaf(candidates: AtcEntry[], atcClasses: Array<{ classId: string }>): AtcEntry | null {
  if (candidates.length === 0) return null;
  for (const atcClass of atcClasses) {
    const match = candidates.find((c) => c.codigo.startsWith(atcClass.classId));
    if (match) return match;
  }
  return candidates[0];
}
