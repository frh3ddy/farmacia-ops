import { PharmaceuticalForm, AdministrationRoute, PackagingType } from '@prisma/client';
import { stripAccents } from './category-classifier';
import {
  findIngredientInText,
  normalizeForIngredientMatch,
  type IngredientSuggestion,
  type PresentacionEntry,
} from '../products/reference-data.service';
import { derivePresentation, inferQuantityUnit, type Substance } from '../products/derived-naming';

export type ParsedIngredient = {
  name: string;
  concentrationValue: number | null;
  concentrationUnit: string | null;
  order: number;
};

export type ParsedProductName = {
  ingredients: ParsedIngredient[];
  form: PharmaceuticalForm | null;
  route: AdministrationRoute | null;
  routeOptions: AdministrationRoute[];
  formOptions: string[];
  concentrationOptions: string[];
  presentation: string | null;
  brand: string | null;
  category: string | null; // the reference dataset's category key, for the subcategory fallback
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
};

const EMPTY_RESULT: ParsedProductName = {
  ingredients: [],
  form: null,
  route: null,
  routeOptions: [],
  formOptions: [],
  concentrationOptions: [],
  presentation: null,
  brand: null,
  category: null,
  confidence: 'LOW',
};

// Ordered, first-match-wins, same idiom as category-classifier.ts's RULES —
// maps both a raw Square name's form-hint text AND the reference dataset's
// own (much more specific) `forma` strings down to the coarse 14-value
// PharmaceuticalForm enum. More specific/compound phrases are checked first
// (e.g. "cápsula de gel" must hit CAPSULE, not GEL).
const FORM_RULES: Array<{ form: PharmaceuticalForm; pattern: RegExp }> = [
  { form: 'INHALER', pattern: /inhalador|inhalacion|nebuliz|turbuhaler|diskus|respimat|handihaler|\bmdi\b/ },
  { form: 'PATCH', pattern: /parche/ },
  { form: 'SUPPOSITORY', pattern: /ovulo|supositorio/ },
  { form: 'INJECTION', pattern: /iny/ },
  { form: 'CAPSULE', pattern: /capsula|perla\b|\bcaps?\b/ },
  { form: 'TABLET', pattern: /tableta|comprimido|gragea|\btabs?\b/ },
  { form: 'CREAM', pattern: /crema/ },
  { form: 'OINTMENT', pattern: /unguento/ },
  { form: 'GEL', pattern: /\bgel\b/ },
  { form: 'SPRAY', pattern: /spray|aerosol|espuma/ },
  { form: 'DROPS', pattern: /gotas|gotero|solucion oftalmica|solucion otica/ },
  { form: 'SYRUP', pattern: /jarabe|elixir|\bjbe\b/ },
  { form: 'SUSPENSION', pattern: /suspension|\bsusp\b/ },
  // ponytail: reconstituted oral powders (polvo para solución/suspensión oral)
  // don't cleanly fit an existing enum bucket once mixed — OTHER rather than
  // guessing SYRUP/SUSPENSION for a form the powder isn't yet in.
  { form: 'OTHER', pattern: /polvo para (solucion|suspension)/ },
  { form: 'CREAM', pattern: /locion/ },
  { form: 'SOLUTION', pattern: /solucion/ },
];

function inferFormEnum(text: string): PharmaceuticalForm | null {
  const normalized = stripAccents(text.toLowerCase());
  for (const rule of FORM_RULES) {
    if (rule.pattern.test(normalized)) return rule.form;
  }
  return null;
}

// vias_administracion strings in the reference dataset -> AdministrationRoute.
// IM/IV/subcutánea all collapse onto the one INJECTABLE enum value, which is
// exactly why route no longer needs a risky form-based guess (see the
// product-name-parser plan): the enum doesn't distinguish them anyway.
const ROUTE_MAP: Record<string, AdministrationRoute> = {
  oral: 'ORAL',
  topica: 'TOPICAL',
  intramuscular: 'INJECTABLE',
  intravenosa: 'INJECTABLE',
  subcutanea: 'INJECTABLE',
  oftalmica: 'OPHTHALMIC',
  otica: 'OTIC',
  nasal: 'NASAL',
  rectal: 'RECTAL',
  vaginal: 'VAGINAL',
  inhalatoria: 'INHALED',
  sublingual: 'SUBLINGUAL',
};

function resolveRouteOptions(viasAdministracion: string[]): AdministrationRoute[] {
  const options: AdministrationRoute[] = [];
  for (const via of viasAdministracion) {
    const route = ROUTE_MAP[stripAccents(via.toLowerCase())];
    if (route && !options.includes(route)) options.push(route);
  }
  return options;
}

// Mexican labels often spell the route out explicitly ("Vía de
// administración: Oral") — a real, unambiguous signal the dataset-driven
// resolveRouteOptions above has no way to see when the ingredient is a
// guess (or a real ingredient whose entry just doesn't cover this route).
// Reuses the exact same ROUTE_MAP, just reading the word straight from text
// instead of from a matched dataset entry's vias_administracion list.
const EXPLICIT_ROUTE_LINE = /v[ií]a\s+de\s+administraci[oó]n\s*:?\s*([a-zàáéíóúñ]+)/i;

function findExplicitRoute(rawText: string): AdministrationRoute | null {
  const match = rawText.match(EXPLICIT_ROUTE_LINE);
  return match ? (ROUTE_MAP[stripAccents(match[1].toLowerCase())] ?? null) : null;
}

// Ordered, first-match-wins over the dataset's own `envase` strings (e.g.
// "caja con ampolletas", "frasco gotero") — richer vocabulary than the
// 10-value PackagingType enum, so this only needs to be best-effort, same
// spirit as FORM_RULES above.
const PACKAGING_RULES: Array<{ type: PackagingType; pattern: RegExp }> = [
  { type: 'BOX', pattern: /caja/ },
  { type: 'VIAL', pattern: /ampula/ },
  { type: 'DROPPER_BOTTLE', pattern: /gotero/ },
  { type: 'BOTTLE', pattern: /frasco|botella|bote/ },
  { type: 'TUBE', pattern: /tubo/ },
  { type: 'AMPOULE', pattern: /ampolleta/ },
  { type: 'SACHET', pattern: /sobre/ },
  { type: 'BLISTER', pattern: /blister/ },
  { type: 'AEROSOL', pattern: /aerosol|spray|espuma/ },
  { type: 'PATCH', pattern: /parche/ },
];

function inferPackagingType(envase: string): PackagingType | null {
  const normalized = stripAccents(envase.toLowerCase());
  for (const rule of PACKAGING_RULES) {
    if (rule.pattern.test(normalized)) return rule.type;
  }
  return null;
}

// ponytail: best-effort package-quantity extraction, no canonical list to
// validate against (unlike concentration) — a miss just leaves quantity
// unset (derivePresentation renders "?"), never a wrong-looking number.
const PACKAGE_COUNT_REGEX = /c\/\s*(\d+)|\b(\d+)\s*(?:tabs?|caps?|comprimidos?|grageas?|ovulos?|supositorios?|perlas?)\b/i;
const VOLUME_CONTENT_REGEX = /(\d+(?:[.,]\d+)?)\s*(?:ml|g)\b/i;

function extractPackageCount(text: string): number | null {
  const m = text.match(PACKAGE_COUNT_REGEX);
  const raw = m?.[1] ?? m?.[2];
  return raw ? parseInt(raw, 10) : null;
}

function extractVolumeContent(text: string): number | null {
  const m = text.match(VOLUME_CONTENT_REGEX);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

// Phase-1 candidate extraction: cheap, deliberately imprecise regexes — the
// real correctness signal is Phase 2's validation against the matched
// ingredient's own canonical `concentraciones` list, not this extraction.
const PER_SEGMENT_UNIT_REGEX = /\d+(?:[.,]\d+)?\s*(?:mg|mcg|ml|g|%|ui)(?:\s*\/\s*\d+(?:[.,]\d+)?\s*(?:mg|mcg|ml|g|%|ui))+\b/gi;
const SHARED_UNIT_REGEX = /\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)*\s*(?:mg|mcg|ml|g|%|ui)\b/gi;

function extractConcentrationCandidate(text: string): string | null {
  const perSegment = text.match(PER_SEGMENT_UNIT_REGEX);
  if (perSegment) return perSegment[0].trim();
  const shared = text.match(SHARED_UNIT_REGEX);
  return shared ? shared[0].trim() : null;
}

function normalizeConcentration(s: string): string {
  return stripAccents(s.toLowerCase()).replace(/\s+/g, '').replace(/,/g, '');
}

const CONCENTRATION_SEGMENT_PATTERN = /^(\d+(?:\.\d+)?)([a-z%]*)$/;

// A combo dose is written two ways across sources: each segment carrying its
// own repeated unit ("500mg/125mg", how Square names write it) or a single
// trailing unit for the whole ratio ("500/125mg", how the reference dataset
// stores it). Collapses the former into the latter so either input form
// compares equal. Segments with genuinely different units (a per-dose
// qualifier like "250mg/5ml") are left alone — collapsing those would lose
// real information, not just a formatting difference.
function canonicalizeConcentration(normalized: string): string {
  const segments = normalized.split('/').map((seg) => seg.match(CONCENTRATION_SEGMENT_PATTERN));
  if (segments.some((m) => !m)) return normalized;
  const units = new Set((segments as RegExpMatchArray[]).map((m) => m[2]).filter(Boolean));
  if (units.size !== 1) return normalized;
  const [unit] = units;
  return (segments as RegExpMatchArray[]).map((m) => m[1]).join('/') + unit;
}

function concentrationsMatch(candidate: string, canonical: string): boolean {
  const a = canonicalizeConcentration(normalizeConcentration(candidate));
  const b = canonicalizeConcentration(normalizeConcentration(canonical));
  if (a === b) return true;
  // Liquids store a canonical per-dose suffix the raw Square name usually
  // omits ("250 mg/5 ml" vs. "250mg") — accept candidate as a prefix of the
  // canonical value. Safe against partial-digit false positives ("25mg"
  // vs. canonical "250mg/5ml") because the candidate's own unit letters
  // must line up exactly at the same position as the canonical's.
  return b.startsWith(a);
}

// Splits a compound ingredient label ("amoxicilina/ácido clavulánico") and
// its matched canonical concentration ("500/125 mg") into per-molecule
// value+unit pairs, positionally. Only handles the dataset's common
// trailing-shared-unit and per-segment-own-unit combo shapes; a labeled
// format like "B1 100mg/B6 5mg/B12 50mcg" doesn't split into ingredient
// names on '/' in the first place (the dataset stores it as one combined
// label), so it's never attempted here — those rows keep null value/unit,
// same as an unfilled AddProductScreen ingredient row.
const SEGMENT_PATTERN = /^(\d+(?:[.,]\d+)?)\s*([a-zA-Z%/\d\s]*)$/;

function parseValueUnit(segment: string): { value: number | null; unit: string | null } {
  const m = segment.match(SEGMENT_PATTERN);
  if (!m) return { value: null, unit: null };
  return { value: parseFloat(m[1].replace(/,/g, '')), unit: m[2].trim() || null };
}

function splitCompoundConcentration(names: string[], matchedConcentration: string | null): ParsedIngredient[] {
  if (!matchedConcentration) {
    return names.map((name, order) => ({ name, concentrationValue: null, concentrationUnit: null, order }));
  }

  if (names.length === 1) {
    const { value, unit } = parseValueUnit(matchedConcentration.trim());
    return [{ name: names[0], concentrationValue: value, concentrationUnit: unit, order: 0 }];
  }

  const segments = matchedConcentration.split('/').map((s) => s.trim());
  if (segments.length !== names.length) {
    return names.map((name, order) => ({ name, concentrationValue: null, concentrationUnit: null, order }));
  }

  const parsed = segments.map(parseValueUnit);
  // Segments with no unit of their own (e.g. "500" in "500/125 mg") inherit
  // the rightmost segment's unit — the dataset's common trailing-shared-unit
  // convention.
  const trailingUnit = [...parsed].reverse().find((p) => p.unit)?.unit ?? null;
  for (const p of parsed) if (!p.unit) p.unit = trailingUnit;

  return names.map((name, order) => ({
    name,
    concentrationValue: parsed[order]?.value ?? null,
    concentrationUnit: parsed[order]?.unit ?? null,
    order,
  }));
}

// Best-effort guess for when the ingredient isn't in the reference dataset
// (static or learned) at all — Mexican OTC/Rx package photos consistently
// print, one line each: brand(+dose), generic/active-ingredient name, form
// ("Tableta"), concentration ("300mg"), packaging ("Caja con 20 Tabletas").
// Only OCR text is ever multi-line (a Square item name is always one line),
// so this never fires on a plain catalog-name parse. Anchors on the form
// line — the most reliably detectable of the five, via the same FORM_RULES
// used everywhere else here — and takes the line above it as the ingredient
// name. The concentration line ("300mg" or "150 mg/10 mg") can print either
// right above or right below the form line depending on the label, so this
// skips back over it rather than assuming a fixed order — but stops at the
// first non-concentration line it hits, never walking further up into
// unrelated brand/dose text. Shaped exactly like a real reference-dataset
// entry but with empty presentaciones/viasAdministracion/brands — that
// emptiness IS the "this is a guess, not canonical data" signal
// parseProductName checks for below.
const REJECT_INGREDIENT_LINE = /\d|caja|frasco|tubo|sobre|ampolleta|blister|envase|contenido|laboratorio/i;
const CONCENTRATION_ONLY_LINE =
  /^\d+(?:[.,]\d+)?\s*(?:mg|mcg|ml|g|%|ui)(?:\s*\/\s*\d+(?:[.,]\d+)?\s*(?:mg|mcg|ml|g|%|ui))*$/i;

// A combo's names print separated by "/" ("Algestona / Estradiol") just as
// often as by "," ("Amantadina, Clorfenamina, Paracetamol") — both split the
// same candidate line, just joined back with "/" afterward so the rest of
// this file (matched.ingredient.split('/'), same as a real dataset combo
// entry) doesn't need a second code path for the comma case.
function splitIngredientLine(line: string): string[] {
  return line
    .split(/[,/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The real "Forma / Concentración" pairing always prints adjacent on a
// label — prefer a form-word line that's actually next to a concentration
// line over the first form word anywhere in the text, which marketing copy
// or a brand tagline can easily contain first (e.g. "Roselt Tabletas con
// ..." naming the product before the real "Tableta" / "50 mg/3 mg/300 mg"
// declaration further down). Falls back to the first match when nothing
// lines up next to a concentration line, same as the old unconditional
// first-match behavior.
function findFormLineIndex(lines: string[]): number {
  const formIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) if (inferFormEnum(lines[i]) !== null) formIndices.push(i);
  if (formIndices.length === 0) return -1;

  const adjacentToConcentration = formIndices.find(
    (i) => CONCENTRATION_ONLY_LINE.test(lines[i - 1] ?? '') || CONCENTRATION_ONLY_LINE.test(lines[i + 1] ?? ''),
  );
  return adjacentToConcentration ?? formIndices[0];
}

function structuralIngredientGuess(rawText: string): IngredientSuggestion | null {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const formIdx = findFormLineIndex(lines);
  if (formIdx < 1) return null;

  let candidateIdx = formIdx - 1;
  while (candidateIdx >= 0 && CONCENTRATION_ONLY_LINE.test(lines[candidateIdx])) candidateIdx--;
  if (candidateIdx < 0) return null;

  // Length/reject checks apply per name, not to the whole line — a 3-drug
  // combo line easily runs past what'd be a reasonable single-name length
  // cap, but each individual name still isn't.
  const names = splitIngredientLine(lines[candidateIdx]);
  if (
    names.length === 0 ||
    names.some((n) => n.length < 3 || n.length > 40 || REJECT_INGREDIENT_LINE.test(stripAccents(n.toLowerCase())))
  ) {
    return null;
  }

  // Line 0 is the brand whenever it's a distinct line from the ingredient
  // candidate itself (a bare-generic product with no separate brand line has
  // candidateIdx === 0, i.e. line 0 IS the candidate) AND actually looks
  // like a name — a noisy scan's first line is sometimes stray OCR junk
  // ("(w)") rather than real print. Feeding a real one back through the
  // exact same `matched.brands.find(...)` lookup below works for free — the
  // OCR text obviously contains its own first line verbatim.
  const brands = candidateIdx > 0 && /[a-zA-Z]{2,}/.test(lines[0]) ? [lines[0]] : [];

  return { ingredient: names.join('/'), brands, category: 'Medicina', viasAdministracion: [], presentaciones: [] };
}

// Presentación for a guess (no canonical envase/quantity to build the
// structured "Forma — Envase c/N" string from, see derivePresentation) falls
// back to whatever packaging line the OCR text actually printed, verbatim —
// "Caja con 1 ampolleta con 1 ml" is right there in the text, no need to
// reconstruct it. Reuses the same PACKAGING_RULES keyword match
// inferPackagingType runs, just to recognize the line rather than classify it.
function findPackagingLineText(rawText: string): string | null {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Search only after the form line — a noisy scan can print an unrelated
  // packaging word before the ingredient block even starts (a price/shelf
  // tag like "Caja15"), and grabbing the first match anywhere would pick
  // that up instead of the real packaging phrase (or correctly finding
  // nothing, per the same "trust nothing without a signal" rule below).
  const formIdx = findFormLineIndex(lines);
  const searchFrom = formIdx >= 0 ? formIdx + 1 : 0;
  const idx = lines.findIndex((l, i) => i >= searchFrom && inferPackagingType(l) !== null);
  if (idx === -1) return null;
  // The packaging phrase's own quantity ("1 ampolleta con 1 ml") sometimes
  // prints as a second OCR line when the box art wraps it — a packaging line
  // with no digit of its own ("Caja con") is never the complete phrase, so
  // pull in the next line rather than truncating.
  if (!/\d/.test(lines[idx]) && lines[idx + 1]) return `${lines[idx]} ${lines[idx + 1]}`;
  return lines[idx];
}

/** Pure, no I/O — parses a raw Square catalog `item_data.name` into
 * suggested product-catalog fields, resolving against the static pharmacy
 * reference dataset (via reference-data.service.ts). Never guesses when the
 * signal isn't there: unmatched names return LOW confidence with empty
 * ingredients rather than a wrong-looking suggestion. */
export function parseProductName(rawName: string): ParsedProductName {
  if (!rawName || !rawName.trim()) return EMPTY_RESULT;

  const guillemetSplit = rawName.split(/«\s*»/);
  const genericText = guillemetSplit[0].trim();
  const brandText = guillemetSplit.length > 1 ? guillemetSplit.slice(1).join(' ').trim() : null;

  // An explicit multi-name candidate line (2+ comma/slash-separated names
  // anchored off the form line) is decisive on its own. findIngredientInText's
  // longest-single-substring-match strategy has no notion of "this line
  // names several drugs side by side": called on the whole blob (or even on
  // the guess's own joined names — one of them can itself be a substring of
  // another dataset key) it'll happily grab just one of N drugs (e.g. only
  // "clorfenamina" out of "Amantadina, Clorfenamina, Paracetamol") and
  // silently drop the rest. Only accept a dataset hit here if it explains
  // every name the guess found — i.e. an actual registered combo, not a
  // partial single-ingredient rescue — otherwise the guess (all N names)
  // wins outright. A single-name candidate line skips straight to the
  // normal dataset-first order below, same precision priority as before.
  const structuralGuess = structuralIngredientGuess(rawName);
  const guessNameCount = structuralGuess ? structuralGuess.ingredient.split('/').length : 0;
  const isComboGuess = guessNameCount > 1;

  const comboDatasetMatch = isComboGuess ? findIngredientInText(structuralGuess!.ingredient) : null;
  const matched = isComboGuess
    ? (comboDatasetMatch && comboDatasetMatch.ingredient.split('/').length === guessNameCount
        ? comboDatasetMatch
        : structuralGuess)
    : (findIngredientInText(genericText) ?? findIngredientInText(rawName) ?? structuralGuess);
  if (!matched) return EMPTY_RESULT;

  // A real dataset/learned entry always ships at least one known
  // presentación; an entry with none is the structural guess above.
  const hasCanonicalData = matched.presentaciones.length > 0;

  const nameFormEnum = inferFormEnum(genericText) ?? inferFormEnum(rawName);
  const matchingPresentaciones: PresentacionEntry[] =
    nameFormEnum && hasCanonicalData ? matched.presentaciones.filter((p) => inferFormEnum(p.forma) === nameFormEnum) : [];

  // True only when the dataset confirms THIS ingredient actually comes in
  // the detected form. False both for a fully-unmatched ingredient (guess,
  // no data at all) AND for a real, matched ingredient whose dataset entry
  // just doesn't happen to list this form — e.g. ambroxol's entry only
  // lists jarabe/tableta/gotas, not solución, so "Ambroxol Solución 300
  // mg/100 mL" matches the ingredient but not the form. Either way there's
  // nothing to cross-check the raw text's own form/dose against, so it's
  // trusted as-is instead of discarded — same idea as every other "trust
  // nothing without a signal" check in this function, just at a lower
  // confidence than a fully-validated match (see confidence below).
  const formValidated = matchingPresentaciones.length > 0;

  const relevantPresentaciones = matchingPresentaciones.length > 0 ? matchingPresentaciones : matched.presentaciones;
  const concentrationOptions = [...new Set(relevantPresentaciones.flatMap((p) => p.concentraciones))];

  const candidateConcentration = extractConcentrationCandidate(genericText) ?? extractConcentrationCandidate(rawName);
  const matchedConcentration = formValidated
    ? (candidateConcentration ? (concentrationOptions.find((c) => concentrationsMatch(candidateConcentration, c)) ?? null) : null)
    : candidateConcentration;

  const ingredientNames = matched.ingredient.split('/').map((s) => s.trim());
  const ingredients = splitCompoundConcentration(ingredientNames, matchedConcentration);

  const routeOptions = resolveRouteOptions(matched.viasAdministracion);
  const route = routeOptions.length === 1 ? routeOptions[0] : routeOptions.length === 0 ? findExplicitRoute(rawName) : null;

  const form = nameFormEnum;

  // Build the same "Forma concentración — Envase c/N unidades" string
  // derived-naming.ts uses elsewhere in the app (e.g. AddProductScreen),
  // rather than inventing a separate phrasing here. Without a validated
  // form there's no envase to build that structured string from, so it
  // falls back to whatever packaging line the raw text itself printed,
  // verbatim — see findPackagingLineText.
  let presentation: string | null = null;
  if (form && !formValidated) {
    presentation = findPackagingLineText(rawName);
  } else if (form && matchingPresentaciones.length > 0) {
    const packagingType = inferPackagingType(matchingPresentaciones[0].envase);
    const searchText = brandText ?? rawName;
    const substances: Substance[] = ingredients.map((i) => ({
      name: i.name,
      value: i.concentrationValue,
      unit: i.concentrationUnit,
      order: i.order,
    }));
    const isPieces = inferQuantityUnit(form) === 'piezas';
    presentation = derivePresentation(
      form,
      substances,
      isPieces ? extractPackageCount(searchText) : extractVolumeContent(searchText),
      isPieces ? null : packagingType,
      isPieces ? packagingType : null,
    );
  }

  const brand =
    brandText ||
    matched.brands.find((b) => normalizeForIngredientMatch(rawName).includes(normalizeForIngredientMatch(b))) ||
    null;

  const confidence: ParsedProductName['confidence'] = !hasCanonicalData
    ? 'LOW'
    : formValidated && matchedConcentration
      ? 'HIGH'
      : 'MEDIUM';

  return {
    ingredients,
    form,
    route,
    routeOptions,
    formOptions: relevantPresentaciones.map((p) => p.forma),
    concentrationOptions,
    presentation,
    brand,
    category: matched.category,
    confidence,
  };
}

const CONFIDENCE_RANK: Record<ParsedProductName['confidence'], number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * Combines an OCR-text parse and a name-text parse into one suggestion,
 * instead of one source unconditionally winning whenever it found anything.
 * `ingredients`/`confidence` aren't blended — they anchor the whole match,
 * so whichever parse actually has ingredients wins outright there (a
 * higher-confidence tier breaks a tie when both do). But every other field
 * a reviewer sees falls back to the *other* parse when the winner left it
 * null — a brand only the Square name's «» marker carries, or a route only
 * OCR text stated, is no longer thrown away just because the other source
 * won on ingredients.
 */
export function mergeParsedProductNames(a: ParsedProductName, b: ParsedProductName): ParsedProductName {
  const aHas = a.ingredients.length > 0;
  const bHas = b.ingredients.length > 0;
  const primary =
    aHas && !bHas ? a : bHas && !aHas ? b : CONFIDENCE_RANK[b.confidence] > CONFIDENCE_RANK[a.confidence] ? b : a;
  const secondary = primary === a ? b : a;

  return {
    ingredients: primary.ingredients,
    confidence: primary.confidence,
    category: primary.category ?? secondary.category,
    form: primary.form ?? secondary.form,
    route: primary.route ?? secondary.route,
    presentation: primary.presentation ?? secondary.presentation,
    brand: primary.brand ?? secondary.brand,
    routeOptions: primary.routeOptions.length > 0 ? primary.routeOptions : secondary.routeOptions,
    formOptions: primary.formOptions.length > 0 ? primary.formOptions : secondary.formOptions,
    concentrationOptions: primary.concentrationOptions.length > 0 ? primary.concentrationOptions : secondary.concentrationOptions,
  };
}
