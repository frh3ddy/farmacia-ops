import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { assert } from 'riteway/vitest';
import { UnmatchedLinesController } from './unmatched-lines.controller';
import { ROLES_KEY } from '../auth/guards/auth.guard';

const line = { id: 'l-1', matchedSaleItemId: null, sale: { locationId: 'centro' } };
const products = { crema: { id: 'crema', name: 'Crema', tracksInventory: true }, luz: { id: 'luz', name: 'Pago de luz', tracksInventory: false } };
const manager = (locationId: string) => ({
  employee: { id: 'emp-mgr' },
  currentLocation: { locationId, role: 'MANAGER' },
  accessibleLocations: [{ locationId, isActive: true }],
});

const match = async ({ request = manager('centro'), found = line as object | null, body = { productId: 'crema' } as { productId?: string } } = {}) => {
  const enqueueMatch = vi.fn();
  const prisma = {
    unmatchedSaleLine: { findUnique: async () => found },
    product: { findUnique: async ({ where }: { where: { id: string } }) => products[where.id as keyof typeof products] ?? null },
  };
  const controller = new UnmatchedLinesController(prisma as any, { enqueueMatch } as any);
  try {
    await controller.match(request as any, 'l-1', body);
    return enqueueMatch.mock.calls;
  } catch (error) {
    return error instanceof HttpException ? [error.getStatus(), (error.getResponse() as { message: string }).message] : error;
  }
};

describe('matching a custom-amount line', () => {
  test('a manager at the sale’s location', async () => {
    assert({
      given: 'a manager matching a pending line at their location to a stocked product',
      should: 'queue the match for the worker, recording who matched it',
      actual: await match(),
      expected: [[{ lineId: 'l-1', productId: 'crema', matchedBy: 'emp-mgr' }]],
    });
  });

  test('refusals', async () => {
    assert({
      given: 'a line at another location, a matched line, a missing line, no product, or a product with no stock',
      should: 'refuse without queueing',
      actual: [
        await match({ request: manager('norte') }),
        await match({ found: { ...line, matchedSaleItemId: 'si-1' } }),
        await match({ found: null }),
        await match({ body: {} }),
        await match({ body: { productId: 'luz' } }),
      ],
      expected: [
        [403, 'No tienes acceso a esta sucursal'],
        [409, 'Esta línea ya está asignada a un producto'],
        [404, 'Sale line not found'],
        [400, 'Elige un producto'],
        [400, 'Pago de luz no tiene existencias'],
      ],
    });
  });

  test('who may match', () => {
    const roles = (method: 'list' | 'match') => Reflect.getMetadata(ROLES_KEY, UnmatchedLinesController.prototype[method]);
    assert({
      given: 'the pending-lines routes',
      should: 'be for owners and managers only, behind the auth and location guards',
      actual: [roles('list'), roles('match'), (Reflect.getMetadata(GUARDS_METADATA, UnmatchedLinesController) ?? []).map((g: Function) => g.name)],
      expected: [['OWNER', 'MANAGER'], ['OWNER', 'MANAGER'], ['AuthGuard', 'LocationGuard']],
    });
  });
});
