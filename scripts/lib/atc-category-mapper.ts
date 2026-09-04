/**
 * ATC -> categoria_terapeutica mapping, per
 * prompt-drug-classification-service.md's "Mapeo ATC -> Categorías
 * terapéuticas" section, extended with level-3 (4-char) entries where a
 * level-2 (3-char) bucket is too coarse (e.g. G03 lumps hormonal
 * contraceptives in with unrelated gynecological estrogens/androgens).
 *
 * Level 3 is the sweet spot for pharmacy-shelf categories: specific enough
 * to split contraceptives from androgens, not so granular you end up with
 * hundreds of one-drug categories. Falls back to level 2 when no level-3
 * entry exists.
 */

export const ATC_TO_CATEGORY: Record<string, string> = {
  // --- Level 3 (4 chars) -- more specific, wins over its level-2 parent ---
  'G03A': 'Anticonceptivos / Planificación familiar',
  'G03B': 'Medicamentos hormonales (andrógenos)',
  'G03C': 'Medicamentos ginecológicos (estrógenos)',

  // --- Level 2 (3 chars) -- fallback ---
  'N02': 'Analgésicos y antipiréticos',
  'M01': 'Antiinflamatorios',
  'J01': 'Antibióticos',
  'R05': 'Antitusivos y expectorantes',
  'R06': 'Antialérgicos',
  'A02': 'Antiácidos y medicamentos gastrointestinales',
  'A07': 'Antidiarreicos',
  'A06': 'Laxantes',
  'A03': 'Antiespasmódicos',
  'A04': 'Antieméticos',
  'A10': 'Medicamentos para diabetes',
  'C02': 'Medicamentos para hipertensión',
  'C03': 'Medicamentos para hipertensión',     // Diuréticos
  'C07': 'Medicamentos para hipertensión',     // Beta-bloqueantes
  'C08': 'Medicamentos para hipertensión',     // Calcio-antagonistas
  'C09': 'Medicamentos para hipertensión',     // IECA/ARA-II
  'C01': 'Medicamentos cardiovasculares',
  'C05': 'Medicamentos cardiovasculares',
  'B01': 'Medicamentos cardiovasculares',      // Anticoagulantes
  'C10': 'Medicamentos para colesterol',
  'A11': 'Vitaminas y minerales',
  'A12': 'Vitaminas y minerales',              // Calcio
  'B03': 'Vitaminas y minerales',              // Hierro/antianémicos
  'D01': 'Antifúngicos',
  'D07': 'Medicamentos dermatológicos',
  'D10': 'Medicamentos dermatológicos',        // Anti-acné
  'J05': 'Antivirales',
  'D08': 'Antisépticos',
  'S01': 'Medicamentos oftálmicos',
  'S02': 'Medicamentos óticos',
  'G03': 'Medicamentos ginecológicos',
  'G01': 'Medicamentos ginecológicos',         // Antiinfecciosos vaginales
  'G04': 'Medicamentos urológicos',
  'R03': 'Medicamentos para enfermedades respiratorias',
  'R01': 'Antigripales',
};

export const SIN_CATEGORIA = 'Sin categoría';

/**
 * Resolve a full ATC code (level 4 or level 5, e.g. "J01CA04") to a
 * pharmacy-shelf category: try the level-3 prefix (4 chars) first, then
 * fall back to level-2 (3 chars). Returns SIN_CATEGORIA if neither the
 * drug's specific subgroup nor its broader group has a mapping yet --
 * that's a real gap in ATC_TO_CATEGORY to fill in, not a bug.
 */
export function getCategoriaTerapeutica(atcCode: string | null): string {
  if (!atcCode) return SIN_CATEGORIA;

  const level3 = atcCode.slice(0, 4);
  if (ATC_TO_CATEGORY[level3]) return ATC_TO_CATEGORY[level3];

  const level2 = atcCode.slice(0, 3);
  if (ATC_TO_CATEGORY[level2]) return ATC_TO_CATEGORY[level2];

  return SIN_CATEGORIA;
}
