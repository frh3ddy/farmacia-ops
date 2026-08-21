import { looseUnitsFromCajas, costPerLooseUnit } from './break-bulk';

describe('looseUnitsFromCajas', () => {
  it('multiplies cajas by the box->piece conversion factor', () => {
    expect(looseUnitsFromCajas(3, 20)).toBe(60);
  });
});

describe('costPerLooseUnit', () => {
  it('divides the total removed cost across the resulting loose units', () => {
    // 3 cajas costing $150 total -> 60 loose units -> $2.50 each
    expect(costPerLooseUnit(150, 60)).toBe(2.5);
  });

  it('preserves cost basis identically whether cajas were single- or cross-lot', () => {
    // Cross-lot: 1 caja at $5 + 2 cajas at $8 = $21 total, cantidad=20 -> 60 loose units
    const crossLotTotal = 5 + 2 * 8;
    expect(costPerLooseUnit(crossLotTotal, 60)).toBeCloseTo(21 / 60);
  });

  it('returns 0 for zero loose units instead of dividing by zero', () => {
    expect(costPerLooseUnit(100, 0)).toBe(0);
  });
});
