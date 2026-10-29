/**
 * Which Square item a stock change is sent under, against a real Postgres
 * engine (see testing/pglite.ts).
 */
import { assert } from 'riteway/vitest';
import { startPostgres } from '../testing/pglite';
import { PrismaService } from '../prisma/prisma.service';
import { findSquareVariationId } from './square-sync';

let prisma: PrismaService;
let stop: () => Promise<void>;
let centro: string;
let norte: string;

beforeAll(async () => {
  ({ prisma, stop } = await startPostgres());
  ({ id: centro } = await prisma.location.create({ data: { squareId: 'SQ-CENTRO', name: 'Centro' } }));
  ({ id: norte } = await prisma.location.create({ data: { squareId: 'SQ-NORTE', name: 'Norte' } }));
}, 120_000);

afterAll(() => stop?.());

/** A product with these mappings: [squareVariationId, locationId | null]. */
async function productMappedAs(mappings: [string, string | null][]) {
  const { id: productId } = await prisma.product.create({ data: { name: `P-${Math.random()}` } });
  for (const [squareVariationId, locationId] of mappings) {
    await prisma.catalogMapping.create({ data: { productId, squareVariationId: `${squareVariationId}-${productId}`, locationId } });
  }
  return { productId, item: (name: string) => `${name}-${productId}` };
}

describe('findSquareVariationId', () => {
  test('a placeholder next to a real item', async () => {
    // Placeholder written for Centro's price, real item synced globally.
    const { productId, item } = await productMappedAs([['local_x', centro], ['real', null]]);

    assert({
      given: 'a local_ placeholder at the location and a real global mapping',
      should: 'use the real Square item',
      actual: await findSquareVariationId(prisma, productId, centro),
      expected: item('real'),
    });
  });

  test('a location mapping and a global one', async () => {
    const { productId, item } = await productMappedAs([['global', null], ['centro', centro]]);

    assert({
      given: "a global mapping and one for the location",
      should: "prefer the location's",
      actual: await findSquareVariationId(prisma, productId, centro),
      expected: item('centro'),
    });
  });

  test('a real item tagged with another location', async () => {
    // The catalog sync tags a mapping with the location it synced from.
    const { productId, item } = await productMappedAs([['real', norte]]);

    assert({
      given: "only a real mapping tagged with another location",
      should: 'still use it — Square items are the same at every location',
      actual: await findSquareVariationId(prisma, productId, centro),
      expected: item('real'),
    });
  });

  test('only a placeholder', async () => {
    const { productId } = await productMappedAs([['local_x', centro]]);

    assert({
      given: 'a product whose only mapping is a local_ placeholder',
      should: 'find no Square item',
      actual: await findSquareVariationId(prisma, productId, centro),
      expected: null,
    });
  });
});
