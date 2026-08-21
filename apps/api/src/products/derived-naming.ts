/**
 * Pure name/presentación derivation for medicamento products. No DB access —
 * callers (products.service.ts) resolve a MedicationDefinition's ingredients
 * into Sustancia[] first, then call these. `name`/`presentation` on Product
 * are the resolved display values: nombreManual/presentacionManual wins when
 * set, otherwise these derived strings are what gets stored.
 */
import { Empaque, PharmaceuticalForm } from '@prisma/client';

export type Sustancia = {
  nombre: string;
  valor: number | null;
  unidad: string | null;
  orden: number;
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
  OTHER: 'Otro',
};

const EMPAQUE_LABELS: Record<Empaque, string> = {
  FRASCO: 'Frasco',
  FRASCO_AMPULA: 'Frasco ámpula',
  TUBO: 'Tubo',
  BLISTER: 'Blíster',
  SOBRE: 'Sobre',
  AMPOLLETA: 'Ampolleta',
  GOTERO: 'Gotero',
  AEROSOL: 'Aerosol',
  PARCHE: 'Parche',
  CAJA: 'Caja',
};

const SOLIDO_FORMS = new Set<PharmaceuticalForm>(['TABLET', 'CAPSULE', 'PATCH', 'SUPPOSITORY', 'INHALER', 'OTHER']);
const LIQUIDO_FORMS = new Set<PharmaceuticalForm>(['SUSPENSION', 'SYRUP', 'DROPS', 'INJECTION', 'SPRAY']);

/** sólidos -> piezas, líquidos -> ml, semisólidos (Crema/Ungüento/Gel) -> g. */
export function inferUnidadCantidad(forma: PharmaceuticalForm): 'piezas' | 'ml' | 'g' {
  if (SOLIDO_FORMS.has(forma)) return 'piezas';
  if (LIQUIDO_FORMS.has(forma)) return 'ml';
  return 'g'; // CREAM, OINTMENT, GEL
}

function sortByOrden(sustancias: Sustancia[]): Sustancia[] {
  return [...sustancias].sort((a, b) => a.orden - b.orden);
}

function concentracionResumen(sustancias: Sustancia[]): string {
  return sortByOrden(sustancias)
    .filter((s) => s.valor !== null && s.unidad !== null)
    .map((s) => `${s.valor}${s.unidad}`)
    .join('/');
}

/** e.g. Amoxicilina/Ácido Clavulánico 500mg/125mg Tableta. Single-substance
 * products collapse naturally — no compound-vs-simple branch. */
export function deriveNombre(sustancias: Sustancia[], forma: PharmaceuticalForm): string {
  const names = sortByOrden(sustancias)
    .map((s) => s.nombre)
    .join('/');
  const concentraciones = concentracionResumen(sustancias);
  return [names, concentraciones, FORM_LABELS[forma]].filter(Boolean).join(' ');
}

// ponytail: plain "-> lowercase + s" pluralization, not proper Spanish
// morphology — every FORM_LABELS entry ends in a vowel so this holds; revisit
// if a future forma label doesn't (e.g. ends in a consonant).
function pluralize(label: string): string {
  return `${label.toLowerCase()}s`;
}

/**
 * e.g. "Tableta 500mg — Caja c/20 tabletas" (empaqueSecundario present),
 * "Solución 120mg/5ml — Frasco 60ml" (primario only). Combo packs and
 * multi-frasco boxes won't reduce cleanly to this formula — presentacionManual
 * is the escape hatch for those, not a case this function tries to cover.
 */
export function derivePresentacion(
  forma: PharmaceuticalForm,
  sustancias: Sustancia[],
  cantidad: number | null,
  empaquePrimario: Empaque | null,
  empaqueSecundario: Empaque | null,
): string {
  const basePart = [FORM_LABELS[forma], concentracionResumen(sustancias)].filter(Boolean).join(' ');

  let empaquePart = '';
  if (empaqueSecundario) {
    empaquePart = `${EMPAQUE_LABELS[empaqueSecundario]} c/${cantidad ?? '?'} ${pluralize(FORM_LABELS[forma])}`;
  } else if (empaquePrimario) {
    const unidad = inferUnidadCantidad(forma);
    empaquePart = `${EMPAQUE_LABELS[empaquePrimario]} ${cantidad ?? '?'}${unidad}`;
  }

  return empaquePart ? `${basePart} — ${empaquePart}` : basePart;
}
