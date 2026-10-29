import { assert } from 'riteway/vitest';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';

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

/** The controller over a recorded service, for an employee at Centro with `role`. */
function priceRouteAs(role: string) {
  const updatePrice = vi.fn().mockResolvedValue({ product: null, previousPrice: 30, newPrice: 40, squareSynced: true, message: 'ok' });
  const controller = new ProductsController({ updatePrice } as any, {} as any, {} as any, {} as any);
  const req = { currentLocation: { locationId: 'centro', role } } as any;
  const send = (body: object) => controller.updatePrice('p1', { sellingPrice: 40, ...body } as any, req).then(
    () => 200,
    (e: any) => e.getStatus(),
  );
  return { updatePrice, send };
}

describe('ProductsController.updatePrice', () => {
  test('a manager', async () => {
    const { updatePrice, send } = priceRouteAs('MANAGER');
    const statuses = [await send({ applyToAllLocations: true }), await send({ locationId: 'norte' }), await send({})];

    assert({
      given: "a manager pricing every location, then another location, then their own",
      should: "refuse the first two with a 403 and change only their own location's price",
      actual: [statuses, updatePrice.mock.calls.map(([input]) => [input.locationId, input.applyToAllLocations])],
      expected: [[403, 403, 200], [['centro', false]]],
    });
  });

  test('an owner', async () => {
    const { updatePrice, send } = priceRouteAs('OWNER');
    const statuses = [await send({ applyToAllLocations: true }), await send({ locationId: 'norte' })];

    assert({
      given: 'an owner pricing every location, then another location',
      should: 'allow both',
      actual: [statuses, updatePrice.mock.calls.map(([input]) => [input.locationId, input.applyToAllLocations])],
      expected: [[200, 200], [['centro', true], ['norte', false]]],
    });
  });
});
