import { deriveNombre, derivePresentacion, inferUnidadCantidad, type Sustancia } from './derived-naming';

const paracetamol: Sustancia = { nombre: 'Paracetamol', valor: 500, unidad: 'mg', orden: 1 };
const amoxicilina: Sustancia = { nombre: 'Amoxicilina', valor: 500, unidad: 'mg', orden: 1 };
const acidoClavulanico: Sustancia = { nombre: 'Ácido Clavulánico', valor: 125, unidad: 'mg', orden: 2 };
const cafeina: Sustancia = { nombre: 'Cafeína', valor: 30, unidad: 'mg', orden: 3 };

describe('deriveNombre', () => {
  it('single substance', () => {
    expect(deriveNombre([paracetamol], 'TABLET')).toBe('Paracetamol 500mg Tableta');
  });

  it('2-substance combination', () => {
    expect(deriveNombre([amoxicilina, acidoClavulanico], 'TABLET')).toBe(
      'Amoxicilina/Ácido Clavulánico 500mg/125mg Tableta',
    );
  });

  it('3+-substance combination', () => {
    expect(deriveNombre([amoxicilina, acidoClavulanico, cafeina], 'TABLET')).toBe(
      'Amoxicilina/Ácido Clavulánico/Cafeína 500mg/125mg/30mg Tableta',
    );
  });

  it('respects orden regardless of array insertion order', () => {
    expect(deriveNombre([acidoClavulanico, amoxicilina], 'TABLET')).toBe(
      'Amoxicilina/Ácido Clavulánico 500mg/125mg Tableta',
    );
  });
});

describe('derivePresentacion', () => {
  it('sólido: forma category with empaqueSecundario present', () => {
    expect(derivePresentacion('TABLET', [paracetamol], 20, 'BLISTER', 'CAJA')).toBe(
      'Tableta 500mg — Caja c/20 tabletas',
    );
  });

  it('líquido: forma category, empaquePrimario only (no secundario)', () => {
    const solucion: Sustancia = { nombre: 'Paracetamol', valor: 120, unidad: 'mg/5ml', orden: 1 };
    expect(derivePresentacion('SUSPENSION', [solucion], 60, 'FRASCO', null)).toBe(
      'Suspensión 120mg/5ml — Frasco 60ml',
    );
  });

  it('semisólido: forma category (Crema/Ungüento/Gel)', () => {
    const crema: Sustancia = { nombre: 'Hidrocortisona', valor: 1, unidad: '%', orden: 1 };
    expect(derivePresentacion('CREAM', [crema], 30, 'TUBO', null)).toBe('Crema 1% — Tubo 30g');
  });

  it('empaqueSecundario omitted falls back to empaquePrimario-only phrasing', () => {
    const result = derivePresentacion('TABLET', [paracetamol], 20, 'BLISTER', null);
    expect(result).toBe('Tableta 500mg — Blíster 20piezas');
  });
});

describe('inferUnidadCantidad', () => {
  it('sólidos -> piezas', () => {
    expect(inferUnidadCantidad('TABLET')).toBe('piezas');
    expect(inferUnidadCantidad('CAPSULE')).toBe('piezas');
  });

  it('líquidos -> ml', () => {
    expect(inferUnidadCantidad('SUSPENSION')).toBe('ml');
    expect(inferUnidadCantidad('SYRUP')).toBe('ml');
  });

  it('semisólidos -> g', () => {
    expect(inferUnidadCantidad('CREAM')).toBe('g');
    expect(inferUnidadCantidad('OINTMENT')).toBe('g');
    expect(inferUnidadCantidad('GEL')).toBe('g');
  });
});
