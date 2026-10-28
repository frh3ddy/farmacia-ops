import { HttpException } from '@nestjs/common';
import { assert } from 'riteway/vitest';
import { SaleReturnsController } from './sale-returns.controller';
import { ROLES_KEY } from '../auth/guards/auth.guard';

// A sale at Centro: 2 jarabes, one already returned.
const sale = { id: 's-1', locationId: 'centro', items: [{ id: 'si-jarabe', quantity: 2, returns: [{ quantity: 1 }] }] };
const cashier = (locationId: string) => ({
  employee: { id: 'emp-cajera' },
  currentLocation: { locationId, role: 'CASHIER' },
  accessibleLocations: [{ locationId, isActive: true }],
});
const body = (items: object[], extra: object = {}) => ({ items, reason: 'No le sirvió', clientRequestId: 'req-1', ...extra });

const record = async ({ request = cashier('centro'), found = sale as object | null, payload = body([{ saleItemId: 'si-jarabe', quantity: 1 }]) as any } = {}) => {
  const enqueueReturn = vi.fn();
  const prisma = { sale: { findUnique: async () => found } };
  const controller = new SaleReturnsController(prisma as any, { enqueueReturn } as any);
  try {
    await controller.record(request as any, 's-1', payload);
    return enqueueReturn.mock.calls;
  } catch (error) {
    return error instanceof HttpException ? [error.getStatus(), (error.getResponse() as { message: string }).message] : error;
  }
};

describe('recording a return', () => {
  test('a return at the sale’s location', async () => {
    assert({
      given: 'what is left of an item, returned at the sale’s location',
      should: 'queue the return, recording who made it',
      actual: await record(),
      expected: [[{ saleId: 's-1', items: [{ saleItemId: 'si-jarabe', quantity: 1 }], reason: 'No le sirvió', returnedBy: 'emp-cajera', clientRequestId: 'req-1' }]],
    });
  });

  test('refusals', async () => {
    assert({
      given: 'another location, a missing sale, more than is left, an item not on the sale, no items, or no request key',
      should: 'refuse without queueing',
      actual: [
        await record({ request: cashier('norte') }),
        await record({ found: null }),
        await record({ payload: body([{ saleItemId: 'si-jarabe', quantity: 2 }]) }),
        await record({ payload: body([{ saleItemId: 'si-other', quantity: 1 }]) }),
        await record({ payload: body([]) }),
        await record({ payload: body([{ saleItemId: 'si-jarabe', quantity: 1 }], { clientRequestId: undefined }) }),
      ],
      expected: [
        [403, 'No tienes acceso a esta sucursal'],
        [404, 'Sale not found'],
        [400, 'Solo puedes devolver 1 del artículo si-jarabe'],
        [400, 'Solo puedes devolver 0 del artículo si-other'],
        [400, 'Elige al menos un artículo para devolver'],
        [400, 'clientRequestId is required'],
      ],
    });
  });

  test('who may return', () => {
    const roles = (method: 'recent' | 'record' | 'list') => Reflect.getMetadata(ROLES_KEY, SaleReturnsController.prototype[method]);
    assert({
      given: 'the returns routes',
      // Staff return in Square; a return by hand is the owner's fallback.
      should: 'let only owners find a sale and return it, and owners and managers review returns',
      actual: [roles('recent'), roles('record'), roles('list')],
      expected: [['OWNER'], ['OWNER'], ['OWNER', 'MANAGER']],
    });
  });
});
