import { assert } from 'riteway/vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard, LocationGuard } from '../auth/guards/auth.guard';
import { ProductPauseController } from './product-pause.controller';
import { pauseProduct, pauseProducts } from './stock-pause';

vi.mock('./stock-pause', () => ({ pauseProduct: vi.fn(async () => undefined), pauseProducts: vi.fn(async () => undefined) }));

/** A request from an employee whose session is at `at`, with that store's role. */
const requestAt = (role: string, at = 'centro') => ({ employee: { id: 'emp-1' }, currentLocation: { locationId: at, role, isActive: true } }) as never;

const routes = () => {
  const products = {
    getProduct: vi.fn(async (id: string, locationId: string) => ({ success: true, data: { id, locationId, stockAlert: { paused: true } } })),
    getProducts: vi.fn(async (_locationId: string, o: { onlyIds: string[] }) => ({ success: true, data: o.onlyIds.map((id) => ({ id })) })),
  };
  const prisma = {};
  return { products, prisma, controller: new ProductPauseController(prisma as never, products as never) };
};

const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: { getStatus: () => number }) => e.getStatus());

describe('ProductPauseController', () => {
  test('who may pause', () => {
    assert({
      given: 'the pause route',
      should: 'need a staff session at a store, as an owner or a manager',
      actual: [Reflect.getMetadata(GUARDS_METADATA, ProductPauseController), Reflect.getMetadata('roles', ProductPauseController.prototype.pause)],
      expected: [[AuthGuard, LocationGuard], ['OWNER', 'MANAGER']],
    });
  });

  test('a pause', async () => {
    const { controller, prisma } = routes();
    const result = await controller.pause('p-1', { locationId: 'centro', reason: 'REPLACED_BY_EQUIVALENT', note: 'Ahora se vende el genérico', replacedByProductId: 'p-2' }, requestAt('MANAGER'));

    assert({
      given: 'a manager pausing a product at their store as replaced by another',
      should: 'pause it with the replacement as that employee and answer with the product\'s updated row at the store',
      actual: [vi.mocked(pauseProduct).mock.calls[0], result],
      expected: [
        [prisma, { productId: 'p-1', locationId: 'centro', reason: 'REPLACED_BY_EQUIVALENT', note: 'Ahora se vende el genérico', replacedByProductId: 'p-2', employeeId: 'emp-1' }],
        { success: true, data: { id: 'p-1', locationId: 'centro', stockAlert: { paused: true } } },
      ],
    });
  });

  test('another store', async () => {
    const { controller } = routes();
    vi.mocked(pauseProduct).mockClear();

    assert({
      given: 'a manager pausing at a store other than their session\'s',
      should: 'refuse with 403 and pause nothing',
      actual: [await statusOf(controller.pause('p-1', { locationId: 'oriente', reason: 'OTHER' }, requestAt('MANAGER'))), vi.mocked(pauseProduct).mock.calls.length],
      expected: [403, 0],
    });
  });

  test('several at once', async () => {
    const { controller, products, prisma } = routes();
    const result = await controller.pauseMany({ locationId: 'centro', productIds: ['p-2', 'p-1', 'p-2'], reason: 'SLOW_MOVER' }, requestAt('OWNER'));

    assert({
      given: 'an owner pausing two products at a store, one of them sent twice',
      should: 'pause them as that employee and answer with each updated row once, in the order sent',
      actual: [
        Reflect.getMetadata('roles', ProductPauseController.prototype.pauseMany),
        vi.mocked(pauseProducts).mock.calls[0],
        products.getProducts.mock.calls[0],
        result,
      ],
      expected: [
        ['OWNER', 'MANAGER'],
        [prisma, { productIds: ['p-2', 'p-1', 'p-2'], locationId: 'centro', reason: 'SLOW_MOVER', employeeId: 'emp-1' }],
        ['centro', { onlyIds: ['p-2', 'p-1'], limit: 2 }],
        { success: true, data: [{ id: 'p-2' }, { id: 'p-1' }] },
      ],
    });
  });

  test('several at another store', async () => {
    const { controller } = routes();
    vi.mocked(pauseProducts).mockClear();

    assert({
      given: 'a manager pausing several products at a store other than their session\'s',
      should: 'refuse with 403 and pause nothing',
      actual: [await statusOf(controller.pauseMany({ locationId: 'oriente', productIds: ['p-1'], reason: 'OTHER' }, requestAt('MANAGER'))), vi.mocked(pauseProducts).mock.calls.length],
      expected: [403, 0],
    });
  });
});
