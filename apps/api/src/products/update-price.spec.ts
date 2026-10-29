import { assert } from 'riteway/vitest';
import { ProductsService } from './products.service';

describe('ProductsService.updatePrice', () => {
  test('a price that is not a number', async () => {
    const prisma = { product: { findUnique: vi.fn() } };
    const products = new ProductsService(prisma as any);

    const outcomes = [];
    for (const sellingPrice of ['abc', '25', NaN, Infinity, -1] as any[]) {
      outcomes.push(await products.updatePrice({ productId: 'p1', sellingPrice, locationId: 'centro' }).then(
        () => 'updated',
        (e: any) => e.status,
      ));
    }

    assert({
      given: 'a price sent as text, a numeric string, NaN, infinity and a negative',
      should: 'refuse each with a 400 before reading or writing any price',
      actual: [outcomes, prisma.product.findUnique.mock.calls.length],
      expected: [[400, 400, 400, 400, 400], 0],
    });
  });
});
