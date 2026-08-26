/**
 * Pure name/presentación derivation for medicamento products. No DB access —
 * callers (products.service.ts) resolve a MedicationDefinition's ingredients
 * into Substance[] first, then call these. `name`/`presentation` on Product
 * are the resolved display values: manualName/manualPresentation wins when
 * set, otherwise these derived strings are what gets stored.
 */
import { PackagingType, PharmaceuticalForm } from '@prisma/client';

export type Substance = {
  name: string;
  value: number | null;
  unit: string | null;
  order: number;
};

const FORM_LABELS: Record<PharmaceuticalForm, string> = {
  TABLET: 'Tableta',
  CAPSULE: 'Cápsula',
  SUSPENSION: 'Suspensión',
  SYRUP: 'Jarabe',
  CREAM: 'Crema',
  OINTMENT: 'Ungüento',
  GEL: 'Gel',
  INJECTION: 'Inyección',
  DROPS: 'Gotas',
  SPRAY: 'Spray',
  PATCH: 'Parche',
  SUPPOSITORY: 'Supositorio',
  INHALER: 'Inhalador',
  SOLUTION: 'Solución',
  OTHER: 'Otro',
};

const PACKAGING_LABELS: Record<PackagingType, string> = {
  BOTTLE: 'Frasco',
  VIAL: 'Frasco ámpula',
  TUBE: 'Tubo',
  BLISTER: 'Blíster',
  SACHET: 'Sobre',
  AMPOULE: 'Ampolleta',
  DROPPER_BOTTLE: 'Gotero',
  AEROSOL: 'Aerosol',
  PATCH: 'Parche',
  BOX: 'Caja',
};

const SOLID_FORMS = new Set<PharmaceuticalForm>(['TABLET', 'CAPSULE', 'PATCH', 'SUPPOSITORY', 'INHALER', 'OTHER']);
const LIQUID_FORMS = new Set<PharmaceuticalForm>(['SUSPENSION', 'SYRUP', 'DROPS', 'INJECTION', 'SPRAY', 'SOLUTION']);

/** sólidos -> piezas, líquidos -> ml, semisólidos (Crema/Ungüento/Gel) -> g. */
export function inferQuantityUnit(form: PharmaceuticalForm): 'piezas' | 'ml' | 'g' {
  if (SOLID_FORMS.has(form)) return 'piezas';
  if (LIQUID_FORMS.has(form)) return 'ml';
  return 'g'; // CREAM, OINTMENT, GEL
}

function sortByOrder(substances: Substance[]): Substance[] {
  return [...substances].sort((a, b) => a.order - b.order);
}

function concentrationSummary(substances: Substance[]): string {
  return sortByOrder(substances)
    .filter((s) => s.value !== null && s.unit !== null)
    .map((s) => `${s.value}${s.unit}`)
    .join('/');
}

/** e.g. Amoxicilina/Ácido Clavulánico 500mg/125mg Tableta. Single-substance
 * products collapse naturally — no compound-vs-simple branch. */
export function deriveName(substances: Substance[], form: PharmaceuticalForm): string {
  const names = sortByOrder(substances)
    .map((s) => s.name)
    .join('/');
  const concentrations = concentrationSummary(substances);
  return [names, concentrations, FORM_LABELS[form]].filter(Boolean).join(' ');
}

// Spanish pluralization: -s after a vowel, -es after a consonant. Every
// FORM_LABELS entry ends in a vowel; some PACKAGING_LABELS don't (Blíster,
// Aerosol), so the consonant branch matters once packaging labels get
// pluralized too (see derivePresentation's nested-packaging branch below).
function pluralize(label: string): string {
  const lower = label.toLowerCase();
  return /[aeiouáéíóúü]$/.test(lower) ? `${lower}s` : `${lower}es`;
}

/**
 * e.g. "Tableta 500mg — Caja c/20 tabletas" (sólido, secondaryPackaging
 * present — quantity is the total piece count; a blister's own count isn't
 * tracked separately), "Solución 120mg/5ml — Frasco 60ml" (primary only).
 *
 * Líquidos/semisólidos with BOTH primaryPackaging and secondaryPackaging are
 * different: the primary package (frasco/tubo) has its own meaningful
 * content distinct from how many of them fit in the secondary package —
 * e.g. "Solución 120mg/5ml — Frasco 10ml — Caja c/12 frascos". That content
 * is `primaryContent`; `quantity` there means frascos/tubos per caja, not
 * total ml. Sólidos don't need this split (see above), so primaryContent
 * is only consulted for non-piezas forms with both packaging levels set.
 *
 * Combo packs and multi-frasco boxes of unusual shapes won't reduce cleanly
 * to this formula — manualPresentation is the escape hatch for those.
 */
export function derivePresentation(
  form: PharmaceuticalForm,
  substances: Substance[],
  quantity: number | null,
  primaryPackaging: PackagingType | null,
  secondaryPackaging: PackagingType | null,
  primaryContent: number | null = null,
): string {
  const basePart = [FORM_LABELS[form], concentrationSummary(substances)].filter(Boolean).join(' ');
  const unit = inferQuantityUnit(form);

  let packagingPart = '';
  if (secondaryPackaging && primaryPackaging && unit !== 'piezas') {
    const primaryLabel = PACKAGING_LABELS[primaryPackaging];
    const primaryPart = `${primaryLabel} ${primaryContent ?? '?'}${unit}`;
    const secondaryPart = `${PACKAGING_LABELS[secondaryPackaging]} c/${quantity ?? '?'} ${pluralize(primaryLabel)}`;
    packagingPart = `${primaryPart} — ${secondaryPart}`;
  } else if (secondaryPackaging) {
    packagingPart = `${PACKAGING_LABELS[secondaryPackaging]} c/${quantity ?? '?'} ${pluralize(FORM_LABELS[form])}`;
  } else if (primaryPackaging) {
    packagingPart = `${PACKAGING_LABELS[primaryPackaging]} ${quantity ?? '?'}${unit}`;
  }

  return packagingPart ? `${basePart} — ${packagingPart}` : basePart;
}
