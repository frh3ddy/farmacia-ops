import { assert } from 'riteway/vitest';
import { ProductsController } from './products.controller';

/**
 * GET /products?filter=…: the chips over the product list. Stock and margin filters
 * run in SQL (product-filters.pg.spec.ts); expiring and at-risk take their ids from
 * the aging service. Margin and at-risk come from cost, so a cashier can't use them.
 */
function routes(role: string) {
  const service = { getProducts: vi.fn(async () => ({ success: true, data: [] })) };
  const aging = {
    getExpiringProducts: vi.fn(async () => [{ productId: 'p-expiring' }]),
    classifyInventoryAging: vi.fn(async () => ['batches']),
    analyzeProductAging: vi.fn(() => [
      { productId: 'p-critical', riskLevel: 'CRITICAL' },
      { productId: 'p-low', riskLevel: 'LOW' },
      { productId: 'p-high', riskLevel: 'HIGH' },
    ]),
  };
  const controller = new ProductsController(service as any, {} as any, {} as any, {} as any, aging as any);
  const centro = { locationId: 'centro', role, isActive: true };
  const req = { currentLocation: centro, accessibleLocations: [centro] } as any; // fixture: only the fields the controller reads
  const list = (filter?: string, search = '') => controller.getProducts('centro', '1', '50', search, '', req, filter);
  const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: any) => e.getStatus());
  const optionsOfLastCall = () => (service.getProducts.mock.calls as any[]).slice(-1)[0]?.[1];
  return { service, aging, list, statusOf, optionsOfLastCall };
}

describe('ProductsController.getProducts with a filter', () => {
  test('a cashier and the cost-based filters', async () => {
    const { service, list, statusOf } = routes('CASHIER');
    const statuses = [await statusOf(list('lowMargin')), await statusOf(list('atRisk'))];

    assert({
      given: 'a cashier asking for the low-margin or at-risk products',
      should: 'refuse both with a 403 and call nothing',
      actual: [statuses, service.getProducts.mock.calls.length],
      expected: [[403, 403], 0],
    });
  });

  test('an unknown filter', async () => {
    const { list, statusOf } = routes('OWNER');

    assert({
      given: 'a filter the server does not know',
      should: 'answer 400',
      actual: await statusOf(list('cheap')),
      expected: 400,
    });
  });

  test('stock filters', async () => {
    const { list, optionsOfLastCall } = routes('CASHIER');
    await list('lowStock', 'amox');

    assert({
      given: 'a cashier filtering low stock within a search',
      should: 'pass the filter and the search to the service',
      actual: [optionsOfLastCall().filter, optionsOfLastCall().search, optionsOfLastCall().onlyIds],
      expected: ['lowStock', 'amox', undefined],
    });

    await list('paused');

    assert({
      given: 'a cashier filtering the paused products',
      should: 'pass the filter to the service like the other stock filters',
      actual: optionsOfLastCall().filter,
      expected: 'paused',
    });
  });

  test('expiring and at-risk', async () => {
    const { aging, list, optionsOfLastCall } = routes('MANAGER');
    await list('expiring');
    const expiring = optionsOfLastCall();
    await list('atRisk');
    const atRisk = optionsOfLastCall();

    assert({
      given: 'a manager filtering expiring, then at-risk products',
      should: "list the aging service's expiring products (within 90 days or expired), then its HIGH and CRITICAL ones",
      actual: [aging.getExpiringProducts.mock.calls[0], expiring.onlyIds, expiring.filter, atRisk.onlyIds],
      expected: [['centro', 90, true], ['p-expiring'], undefined, ['p-critical', 'p-high']],
    });
  });

  test('no filter', async () => {
    const { aging, list, optionsOfLastCall } = routes('OWNER');
    await list(undefined);
    await list('');

    assert({
      given: 'no filter, or an empty one',
      should: 'list as before, without asking the aging service',
      actual: [optionsOfLastCall().filter, optionsOfLastCall().onlyIds, aging.getExpiringProducts.mock.calls.length],
      expected: [undefined, undefined, 0],
    });
  });
});
