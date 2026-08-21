import { classifyProductName, classifySubcategory, stripAccents, type CategoryRow } from './category-classifier';

describe('stripAccents', () => {
  it('removes accents and diacritics', () => {
    expect(stripAccents('Pañal Niño Colágeno')).toBe('Panal Nino Colageno');
  });
});

describe('classifyProductName', () => {
  it('classifies adult diapers before infant diapers (rule precedence)', () => {
    expect(classifyProductName('Pañal para adulto talla M')).toBe('Cuidado/incontinencia adulto');
  });

  it('classifies infant diapers', () => {
    expect(classifyProductName('Pañal talla 3 bebe')).toBe('Cuidado infantil');
  });

  it('classifies medication by dosage/form pattern', () => {
    expect(classifyProductName('Paracetamol 500mg tabs')).toBe('Medicina');
  });

  it('classifies hair/hygiene products', () => {
    expect(classifyProductName('Shampoo anticaspa')).toBe('Cuidado capilar e higiene');
  });

  it('is case- and accent-insensitive', () => {
    expect(classifyProductName('SHAMPOO ANTICASPA')).toBe('Cuidado capilar e higiene');
  });

  it('falls back to Sin clasificar when no rule matches', () => {
    expect(classifyProductName('Producto genérico sin categoría clara')).toBe('Sin clasificar');
  });
});

describe('classifySubcategory', () => {
  const subcategories: CategoryRow[] = [
    { id: '1', name: 'Cremas para manos', parentId: 'p1' },
    { id: '2', name: 'Guantes de látex', parentId: 'p1' },
  ];

  it('returns the single matching subcategory', () => {
    expect(classifySubcategory('Crema para manos hidratante', subcategories)).toEqual(subcategories[0]);
  });

  it('returns null when no subcategory matches', () => {
    expect(classifySubcategory('Jarabe para la tos', subcategories)).toBeNull();
  });

  it('returns null when more than one subcategory matches (ambiguous)', () => {
    const ambiguous: CategoryRow[] = [
      { id: '1', name: 'Guantes', parentId: 'p1' },
      { id: '2', name: 'Guantes de látex', parentId: 'p1' },
    ];
    expect(classifySubcategory('Guantes de látex talla M', ambiguous)).toBeNull();
  });
});
