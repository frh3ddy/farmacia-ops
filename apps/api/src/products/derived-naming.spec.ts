import { deriveName, derivePresentation, inferQuantityUnit, type Substance } from './derived-naming';

const paracetamol: Substance = { name: 'Paracetamol', value: 500, unit: 'mg', order: 1 };
const amoxicillin: Substance = { name: 'Amoxicilina', value: 500, unit: 'mg', order: 1 };
const clavulanicAcid: Substance = { name: 'Ácido Clavulánico', value: 125, unit: 'mg', order: 2 };
const caffeine: Substance = { name: 'Cafeína', value: 30, unit: 'mg', order: 3 };

describe('deriveName', () => {
  it('single substance', () => {
    expect(deriveName([paracetamol], 'TABLET')).toBe('Paracetamol 500mg Tableta');
  });

  it('2-substance combination', () => {
    expect(deriveName([amoxicillin, clavulanicAcid], 'TABLET')).toBe(
      'Amoxicilina/Ácido Clavulánico 500mg/125mg Tableta',
    );
  });

  it('3+-substance combination', () => {
    expect(deriveName([amoxicillin, clavulanicAcid, caffeine], 'TABLET')).toBe(
      'Amoxicilina/Ácido Clavulánico/Cafeína 500mg/125mg/30mg Tableta',
    );
  });

  it('respects order regardless of array insertion order', () => {
    expect(deriveName([clavulanicAcid, amoxicillin], 'TABLET')).toBe(
      'Amoxicilina/Ácido Clavulánico 500mg/125mg Tableta',
    );
  });
});

describe('derivePresentation', () => {
  it('sólido: form category with secondaryPackaging present', () => {
    expect(derivePresentation('TABLET', [paracetamol], 20, 'BLISTER', 'BOX')).toBe(
      'Tableta 500mg — Caja c/20 tabletas',
    );
  });

  it('líquido: form category, primaryPackaging only (no secondary)', () => {
    const solution: Substance = { name: 'Paracetamol', value: 120, unit: 'mg/5ml', order: 1 };
    expect(derivePresentation('SUSPENSION', [solution], 60, 'BOTTLE', null)).toBe(
      'Suspensión 120mg/5ml — Frasco 60ml',
    );
  });

  it('semisólido: form category (Crema/Ungüento/Gel)', () => {
    const cream: Substance = { name: 'Hidrocortisona', value: 1, unit: '%', order: 1 };
    expect(derivePresentation('CREAM', [cream], 30, 'TUBE', null)).toBe('Crema 1% — Tubo 30g');
  });

  it('secondaryPackaging omitted falls back to primaryPackaging-only phrasing', () => {
    const result = derivePresentation('TABLET', [paracetamol], 20, 'BLISTER', null);
    expect(result).toBe('Tableta 500mg — Blíster 20piezas');
  });

  it('líquido nested packaging: bottle content and bottles-per-box are tracked separately', () => {
    const solution: Substance = { name: 'Paracetamol', value: 120, unit: 'mg/5ml', order: 1 };
    // 1 bottle of 10ml, 1 bottle per box — the exact "bottle inside a box" case.
    const result = derivePresentation('SUSPENSION', [solution], 1, 'BOTTLE', 'BOX', 10);
    expect(result).toBe('Suspensión 120mg/5ml — Frasco 10ml — Caja c/1 frascos');
  });

  it('líquido nested packaging: a case of several bottles', () => {
    const solution: Substance = { name: 'Paracetamol', value: 120, unit: 'mg/5ml', order: 1 };
    const result = derivePresentation('SUSPENSION', [solution], 12, 'BOTTLE', 'BOX', 10);
    expect(result).toBe('Suspensión 120mg/5ml — Frasco 10ml — Caja c/12 frascos');
  });

  it('semisólido nested packaging: tubes in a box', () => {
    const cream: Substance = { name: 'Hidrocortisona', value: 1, unit: '%', order: 1 };
    const result = derivePresentation('CREAM', [cream], 6, 'TUBE', 'BOX', 30);
    expect(result).toBe('Crema 1% — Tubo 30g — Caja c/6 tubos');
  });

  it('sólido nested packaging is unaffected — quantity stays the total piece count, not a blister count', () => {
    // Regression: adding primaryContent must not change the existing sólido formula.
    const result = derivePresentation('TABLET', [paracetamol], 20, 'BLISTER', 'BOX', 999);
    expect(result).toBe('Tableta 500mg — Caja c/20 tabletas');
  });

  it('pluralizes a packaging label ending in a consonant correctly (Blíster -> blísteres, not "blísters")', () => {
    const result = derivePresentation('SUSPENSION', [paracetamol], 3, 'BLISTER', 'BOX', 15);
    expect(result).toContain('blísteres');
  });
});

describe('inferQuantityUnit', () => {
  it('sólidos -> piezas', () => {
    expect(inferQuantityUnit('TABLET')).toBe('piezas');
    expect(inferQuantityUnit('CAPSULE')).toBe('piezas');
  });

  it('líquidos -> ml', () => {
    expect(inferQuantityUnit('SUSPENSION')).toBe('ml');
    expect(inferQuantityUnit('SYRUP')).toBe('ml');
  });

  it('semisólidos -> g', () => {
    expect(inferQuantityUnit('CREAM')).toBe('g');
    expect(inferQuantityUnit('OINTMENT')).toBe('g');
    expect(inferQuantityUnit('GEL')).toBe('g');
  });
});
