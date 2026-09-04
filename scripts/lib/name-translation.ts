/**
 * Spanish -> English/INN active-ingredient name cleanup, extracted out of
 * generate-drug-classification-test-data.ts so run-full-catalog-tiers-1-3.ts
 * can reuse the same logic instead of a second copy of the translation
 * dicts. RxNav/OpenFDA/WHO-ATC are all indexed by English INN names, so a
 * raw Spanish generic name is unlikely to resolve as-is.
 */
export const MEDICINE_NAME_PATTERN = /\d+\s?(mg|mcg|ml|g|ui|%)\b/i;

const NBSP = String.fromCharCode(0xa0);

// Known irregulars that the suffix rules below don't handle correctly --
// either a prefix change (cloranfenicol -> chloramphenicol), a word-order
// flip (sulfadiazina de plata -> silver sulfadiazine), or a suffix pattern
// too rare to earn a general rule. Matched against the already
// noise-stripped ingredient phrase, lowercased.
const KNOWN_TRANSLATIONS: Record<string, string> = {
  'ac acetilsalicilico': 'Acetylsalicylic acid',
  'acido acetilsalicilico': 'Acetylsalicylic acid',
  'bencilpenicilina benzatinica compuesta': 'Benzathine benzylpenicillin',
  'bencilpenicilina benzatinica': 'Benzathine benzylpenicillin',
  'alopurinol': 'Allopurinol',
  'pentoxifilina': 'Pentoxifylline',
  'cloranfenicol': 'Chloramphenicol',
  'sulfadiazina de plata': 'Silver sulfadiazine',
  'trimetoprima': 'Trimethoprim', // suffix rules can't reach this -- "-oprima" isn't a productive pattern, and RxNav's fuzzy match doesn't get close enough on its own
  'sulfametoxazol': 'Sulfamethoxazole', // "-azol$"->"-azole" alone gives "Sulfametoxazole", missing the mid-word "th" -- resolves fine alone via RxNav's fuzzy match, but breaks its combo-name lookup (verified: exact spelling needed there, unlike the single-ingredient search)
  'claritromicina': 'Clarithromycin', // "-micina$"->"-mycin" gives "Claritromycin" -- unlike gentamicin/gentamycin, RxNav does NOT fuzzy-match this one without the mid-word "h"
};

// Productive Spanish->English INN suffix patterns, most specific first.
const SUFFIX_RULES: Array<[RegExp, string]> = [
  [/cilina$/i, 'cillin'], // Amoxicilina -> Amoxicillin
  [/axima$/i, 'axime'], // Cefotaxima -> Cefotaxime
  [/micina$/i, 'mycin'], // Gentamicina -> Gentamicin (aminoglycosides -- must come before the generic "ina$" rule below)
  [/azol$/i, 'azole'],
  [/ino$/i, 'ine'], // Amlodipino -> Amlodipine
  [/eno$/i, 'en'], // Ibuprofeno -> Ibuprofen, Naproxeno -> Naproxen
  [/aco$/i, 'ac'], // Diclofenaco -> Diclofenac, Ketorolaco -> Ketorolac
  [/ona$/i, 'one'], // Ceftriaxona -> Ceftriaxone
  [/ina$/i, 'ine'], // fallback generic case
];

// Same idea as KNOWN_TRANSLATIONS, but for cleaning up the Spanish phrase
// itself -- extractIngredientPhrase() gives back the catalog's own
// (sometimes abbreviated) wording verbatim, e.g. "Ac Acetilsalicilico".
const KNOWN_SPANISH_NAMES: Record<string, string> = {
  'ac acetilsalicilico': 'Ácido acetilsalicílico',
  'acido acetilsalicilico': 'Ácido acetilsalicílico',
  'bencilpenicilina benzatinica compuesta': 'Bencilpenicilina benzatínica',
  'bencilpenicilina benzatinica': 'Bencilpenicilina benzatínica',
};

/** Strip accents so suffix-rule matching doesn't need to special-case them. */
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Isolate the leading active-ingredient phrase from a raw Square item name:
 * normalize whitespace, drop anything from a "«»" marker onward (brand/pack
 * noise) and any parenthetical route/form note, then truncate at the first
 * digit -- dosage, quantity, and packaging always come after the ingredient
 * name in this catalog's naming, so everything from there on (dosage,
 * "Susp.", "Tab", brand suffixes, "C/1 Amp", ...) is noise for a name
 * lookup, whether or not it's wrapped in parens or a recognized unit.
 */
export function extractIngredientPhrase(rawName: string): string {
  let name = rawName.split(NBSP).join(' ').replace(/\s+/g, ' ').trim();
  const marker = '«»';
  const markerIndex = name.indexOf(marker);
  if (markerIndex !== -1) {
    name = name.slice(0, markerIndex).trim();
  }
  name = name.replace(/\([^)]*\)/g, ''); // drop route/form parentheticals, e.g. "(Susp Oral)"
  const firstDigitIndex = name.search(/\d/);
  if (firstDigitIndex !== -1) {
    name = name.slice(0, firstDigitIndex);
  }
  return name.replace(/[.,]+$/, '').replace(/\s+/g, ' ').trim();
}

function translateSinglePhrase(phrase: string): string {
  const key = stripAccents(phrase).toLowerCase();
  if (KNOWN_TRANSLATIONS[key]) return KNOWN_TRANSLATIONS[key];

  return phrase
    .split(' ')
    .map((word) => {
      for (const [pattern, replacement] of SUFFIX_RULES) {
        if (pattern.test(word)) return word.replace(pattern, replacement);
      }
      return word;
    })
    .join(' ');
}

/**
 * Translate a cleaned Spanish ingredient phrase to its English/INN form,
 * best-effort. "+"-joined combo names (this catalog's own separator, e.g.
 * "Trimetoprima+Sulfametoxazol") are split and translated per-ingredient
 * then rejoined with "/" -- RxNav's own combo-naming convention (confirmed:
 * "Sulfamethoxazole/Trimethoprim" resolves cleanly where the untranslated
 * "+"-joined original doesn't) -- rather than run the suffix rules over the
 * whole joined string, which only ever reaches the trailing word.
 */
export function translateActiveIngredient(rawName: string): string {
  const phrase = extractIngredientPhrase(rawName);
  if (phrase.includes('+')) {
    return phrase
      .split('+')
      .map((part) => translateSinglePhrase(part.trim()))
      .join('/');
  }
  return translateSinglePhrase(phrase);
}

/** The active ingredient in Spanish, for display -- the English form is only for RxNav/OpenFDA/ATC lookups. */
export function spanishActiveIngredient(rawName: string): string {
  const phrase = extractIngredientPhrase(rawName);
  const key = stripAccents(phrase).toLowerCase();
  return KNOWN_SPANISH_NAMES[key] ?? phrase;
}
