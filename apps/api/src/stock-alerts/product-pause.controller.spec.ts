import { assert } from 'riteway/vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard, LocationGuard } from '../auth/guards/auth.guard';
import { ProductPauseController } from './product-pause.controller';
import { pauseProduct } from './stock-pause';

vi.mock('./stock-pause', () => ({ pauseProduct: vi.fn(async () => undefined) }));

/** A request from an employee whose session is at `at`, with that store's role. */
const requestAt = (role: string, at = 'centro') => ({ employee: { id: 'emp-1' }, currentLocation: { locationId: at, role, isActive: true } }) as never;

const routes = () => {
  const products = { getProduct: vi.fn(async (id: string, locationId: string) => ({ success: true, data: { id, locationId, stockAlert: { paused: true } } })) };
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
    const result = await controller.pause('p-1', { locationId: 'centro', reason: 'SUPPLIER_UNAVAILABLE', note: 'Sin surtido' }, requestAt('MANAGER'));

    assert({
      given: 'a manager pausing a product at their store',
      should: 'pause it as that employee and answer with the product\'s updated row at the store',
      actual: [vi.mocked(pauseProduct).mock.calls[0], result],
      expected: [
        [prisma, { productId: 'p-1', locationId: 'centro', reason: 'SUPPLIER_UNAVAILABLE', note: 'Sin surtido', employeeId: 'emp-1' }],
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
});
