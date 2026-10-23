import { mappingPriceFields } from './catalog.service';

describe('mappingPriceFields', () => {
  it('writes the price Square returned', () => {
    const fields = mappingPriceFields(1250, 'MXN');
    expect(fields).toMatchObject({ currency: 'MXN' });
    expect(fields.priceCents?.toString()).toBe('1250');
    expect(fields.priceSyncedAt).toBeInstanceOf(Date);
  });

  it('keeps a zero price', () => {
    expect(mappingPriceFields(0, null).priceCents?.toString()).toBe('0');
  });

  // A failed Square detail fetch leaves priceCents null — the resync must not
  // wipe the cached price, so no price columns are written at all.
  it.each([null, undefined, NaN])('writes nothing for %p', (price) => {
    expect(mappingPriceFields(price, 'USD')).toEqual({});
  });
});
