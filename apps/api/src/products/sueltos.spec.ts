import { formatStock } from './sueltos';

describe('formatStock', () => {
  it('187 piezas, cantidad 20 -> 9 cajas + 7 tabletas', () => {
    expect(formatStock(187, 20)).toBe('9 cajas + 7 tabletas');
  });

  it('exact multiple of cantidad -> cajas only, no "+ 0 tabletas"', () => {
    expect(formatStock(40, 20)).toBe('2 cajas');
  });

  it('fewer base units than one caja -> sueltas only', () => {
    expect(formatStock(7, 20)).toBe('7 tabletas');
  });

  it('falls back to a raw count when cantidad is null', () => {
    expect(formatStock(50, null)).toBe('50 piezas');
  });

  it('falls back to a raw count when cantidad is 0', () => {
    expect(formatStock(50, 0)).toBe('50 piezas');
  });
});
