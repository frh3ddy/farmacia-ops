/**
 * Best-effort extraction of ficha fields (marca, via_administracion,
 * forma_farmaceutica, envase) straight from a raw Square catalog item
 * name -- this data already exists in the catalog, no external source
 * needed for it. Real-world Spanish pharmacy label text is inconsistent
 * (no reliable separator, abbreviations vary, "«»" isn't always present),
 * so this is pattern matching over common conventions in THIS catalog's
 * naming, not a general-purpose parser -- expect misses on names that
 * don't follow the patterns already seen.
 */

const NBSP = String.fromCharCode(0xa0);
const MARKER = '«»';

// Order matters: check combined "suspension/solution + injectable" before
// the plain form alone, so "Sol. Iny." doesn't just match as "Solución".
const FORM_PATTERNS: Array<[RegExp, string]> = [
  [/susp\.?\s*iny\.?/i, 'Suspensión inyectable'],
  [/sol\.?\s*iny\.?/i, 'Solución inyectable'],
  [/susp(ensi[oó]n)?\b/i, 'Suspensión'],
  [/tab(s|letas?)?\b/i, 'Tabletas'],
  [/c[aá]p(s|s[uú]las?)?\b/i, 'Cápsulas'],
  [/crema\b/i, 'Crema'],
  [/ung[uü]ento\b/i, 'Ungüento'],
  [/jarabe\b/i, 'Jarabe'],
  [/gotas\b/i, 'Gotas'],
];

const ROUTE_PATTERNS: Array<[RegExp, string]> = [
  [/\bi\.?\s?m\.?\b/i, 'Intramuscular'],
  [/\bi\.?\s?v\.?\b/i, 'Intravenosa'],
  [/\boral\b/i, 'Oral'],
  [/\brectal\b/i, 'Rectal'],
  [/\bsublingual\b/i, 'Sublingual'],
  [/\bvaginal\b/i, 'Vaginal'],
  [/\bo[ft]t[aá]lmic[ao]\b/i, 'Oftálmica'],
  [/\b[oó]tic[ao]\b/i, 'Ótica'],
  [/\bt[oó]pic[ao]\b/i, 'Tópica'],
];

// Packaging/container fragments -- quantity+unit, container words, "c/N".
// Deliberately excludes mg/mcg/UI/% -- those are dosage units (already
// captured separately), never a package-size unit in this domain, so
// including them just duplicates the dosage into the envase field. Bare
// "g"/"ml" are kept (container/vial size, e.g. "1 G" frasco ámpula, "75 ML"
// bottle) even though they can coincidentally equal the dosage number.
const ENVASE_TOKEN_PATTERN = /\bc\/\d+[^\s,.]*|\bcaja\b[^,.]*|\btubo\b|\bfco\.?\b|\bfrasco\b|\bamp(olleta)?\.?\b|\d+(\.\d+)?\s?(ml|l|g)\b(?!\s*mg)/gi;

export interface ParsedSquareName {
  marca: string | null;
  via_administracion: string | null;
  forma_farmaceutica: string | null;
  envase: string | null;
}

export interface PrincipioActivo {
  nombre: string;
  dosis: string | null;
}

// A run of 2+ numbers separated by "/" with one shared trailing unit, e.g.
// "150/10mg", "200/200/20 MG", "40/200 MG" -- the common case across the
// catalog's combination products. Deliberately doesn't attempt the rarer
// per-segment-unit variant (e.g. "0.5mg/500mg/100,000u.") or cases where
// the dose order is inconsistent between the name and the packaging tail --
// falls back to a single combined entry rather than risk a wrong pairing.
const DOSE_GROUP_PATTERN = /[\d.,]+(?:\s*\/\s*[\d.,]+)+\s?(mg|mcg|ml|g|ui|%)\b\.?/i;

// Plain single-number dose, e.g. "250mg" -- the ordinary single-ingredient
// case, which never matches DOSE_GROUP_PATTERN (that one requires a "/").
const SIMPLE_DOSE_PATTERN = /[\d,]+\s?(mg|mcg|ml|g|ui|%)\.?/i;

export function parseSquareName(rawName: string): ParsedSquareName {
  const normalized = rawName.split(NBSP).join(' ').replace(/\s+/g, ' ').trim();

  let forma_farmaceutica: string | null = null;
  for (const [pattern, label] of FORM_PATTERNS) {
    if (pattern.test(normalized)) {
      forma_farmaceutica = label;
      break;
    }
  }

  let via_administracion: string | null = null;
  for (const [pattern, label] of ROUTE_PATTERNS) {
    if (pattern.test(normalized)) {
      via_administracion = label;
      break;
    }
  }
  if (!via_administracion && forma_farmaceutica === 'Tabletas') {
    via_administracion = 'Oral'; // tablets are virtually always oral -- safe default, not a real signal
  }

  // Marca: first token after the "«»" marker, when present. Names without
  // the marker don't have a reliable brand signal in this catalog.
  let marca: string | null = null;
  const markerIndex = normalized.indexOf(MARKER);
  if (markerIndex !== -1) {
    const tail = normalized.slice(markerIndex + MARKER.length).trim();
    marca = tail.split(/\s+/)[0] || null;
  }

  const envaseMatches = normalized.match(ENVASE_TOKEN_PATTERN) || [];
  const envase = envaseMatches.length > 0 ? [...new Set(envaseMatches.map((s) => s.trim()))].join(', ') : null;

  return { marca, via_administracion, forma_farmaceutica, envase };
}

/**
 * Extract one or more {nombre, dosis} entries from a raw Square item name.
 * Multi-ingredient combos in this catalog are usually "+"-joined names
 * (e.g. "Trimetoprima+Sulfametoxazol") paired with a "/"-separated dose
 * group sharing one trailing unit (e.g. "40/200mg") -- when both the
 * ingredient count and the dose count line up, zip them 1:1. Anything that
 * doesn't cleanly fit that shape (no "+" -- e.g. space-joined names like
 * "Betametasona clotrimazol gentamicina", which can't be split without a
 * known-ingredient dictionary -- or a count mismatch) falls back to one
 * entry covering the whole phrase, same as an ordinary single-ingredient
 * product. Never guesses a name-to-dose pairing it isn't confident about.
 */
export function extractPrincipiosActivos(rawName: string): PrincipioActivo[] {
  const normalized = rawName.split(NBSP).join(' ').replace(/\s+/g, ' ').trim();

  let namesPart = normalized;
  const markerIndex = namesPart.indexOf(MARKER);
  if (markerIndex !== -1) {
    namesPart = namesPart.slice(0, markerIndex).trim();
  }
  namesPart = namesPart.replace(/\([^)]*\)/g, ''); // drop route/form parentheticals
  const firstDigitIndex = namesPart.search(/\d/);
  if (firstDigitIndex !== -1) {
    namesPart = namesPart.slice(0, firstDigitIndex);
  }
  namesPart = namesPart.replace(/[.,]+$/, '').trim();

  // The dose group can live right after the ingredient list, or only in the
  // packaging tail after "«»" -- search the whole raw name for it.
  const doseMatch = normalized.match(DOSE_GROUP_PATTERN);

  if (namesPart.includes('+') && doseMatch) {
    const names = namesPart.split('+').map((s) => s.trim()).filter(Boolean);
    const unit = doseMatch[1];
    const numbers = doseMatch[0]
      .replace(new RegExp(`\\s?${unit}\\.?$`, 'i'), '')
      .split('/')
      .map((s) => s.trim());

    if (names.length === numbers.length) {
      return names.map((nombre, i) => ({ nombre, dosis: `${numbers[i]}${unit}` }));
    }
  }

  const fallbackDose = doseMatch ?? normalized.match(SIMPLE_DOSE_PATTERN);
  return [{ nombre: namesPart || normalized, dosis: fallbackDose ? fallbackDose[0].trim() : null }];
}

export interface Strength {
  valor: number;
  unidad: string;
  por: string | null; // e.g. "5 mL" for a "200 mg/5 mL" concentration, null for a flat "100mg"
}

// number (+unit) optionally followed by "/<amount+unit>", e.g. "100mg" or
// "200 mg/5 mL". Best-effort: a range like "400-800 mg" (seen in some
// tier-4 free-text results, e.g. "según presentación") only matches its
// second number -- ranges aren't modeled, not worth it for a handful of
// ambiguous multi-presentation cases.
const STRENGTH_PATTERN = /([\d.,]+)\s?(mg|mcg|ml|g|ui|%)(?:\s?\/\s?([\d.,]+\s?(?:mg|mcg|ml|g|ui|%|l)))?/i;

/** Break a free-text dosis string (from either the Square name or tier-4 web search) into a structured strength. */
export function parseStrength(dosis: string | null): Strength | null {
  if (!dosis) return null;
  const match = dosis.match(STRENGTH_PATTERN);
  if (!match) return null;
  const valor = parseFloat(match[1].replace(/,/g, ''));
  if (Number.isNaN(valor)) return null;
  return { valor, unidad: match[2].toLowerCase(), por: match[3] ? match[3].trim() : null };
}
