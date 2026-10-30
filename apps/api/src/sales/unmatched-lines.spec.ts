import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { assert } from 'riteway/vitest';
import { UnmatchedLinesController } from './unmatched-lines.controller';
import { ROLES_KEY } from '../auth/guards/auth.guard';

const line = { id: 'l-1', matchedSaleItemId: null, sale: { locationId: 'centro' } };
const stocked = { tracksInventory: true, isDiscontinued: false, soldOnlyAtLocationId: null };
const products = {
  crema: { id: 'crema', name: 'Crema', ...stocked },
  luz: { id: 'luz', name: 'Pago de luz', ...stocked, tracksInventory: false },
  vieja: { id: 'vieja', name: 'Crema vieja', ...stocked, isDiscontinued: true },
  juguete: { id: 'juguete', name: 'Juguete', ...stocked, soldOnlyAtLocationId: 'norte' },
  local: { id: 'local', name: 'Juguete de Centro', ...stocked, soldOnlyAtLocationId: 'centro' },
};
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
      given: 'a line at another location, a matched line, a missing line, no product, a product with no stock, a discontinued one, or one sold only at another store',
      should: 'refuse without queueing',
      actual: [
        await match({ request: manager('norte') }),
        await match({ found: { ...line, matchedSaleItemId: 'si-1' } }),
        await match({ found: null }),
        await match({ body: {} }),
        await match({ body: { productId: 'luz' } }),
        await match({ body: { productId: 'vieja' } }),
        await match({ body: { productId: 'juguete' } }),
      ],
      expected: [
        [403, 'No tienes acceso a esta sucursal'],
        [409, 'Esta línea ya está asignada a un producto'],
        [404, 'Línea de venta no encontrada'],
        [400, 'Elige un producto'],
        [400, 'Pago de luz no tiene existencias'],
        [400, 'Crema vieja está descontinuado'],
        [400, 'Juguete no se vende en esta sucursal'],
      ],
    });
  });

  test('a product sold only at the sale’s store', async () => {
    assert({
      given: 'a product sold only at the store the line was sold at',
      should: 'queue the match',
      actual: await match({ body: { productId: 'local' } }),
      expected: [[{ lineId: 'l-1', productId: 'local', matchedBy: 'emp-mgr' }]],
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

describe('the pending lines', () => {
  const pending = async () => {
    const findMany = vi.fn(async () => [{ id: 'l-1' }, { id: 'l-2' }]);
    const failedJobs = async () => [
      { data: { lineId: 'l-2', productId: 'crema' }, failedReason: 'Sale validation error: Crema no tiene costo', finishedOn: 5 },
      { data: { lineId: 'l-9', productId: 'crema' }, failedReason: 'other line', finishedOn: 6 },
    ];
    const controller = new UnmatchedLinesController({ unmatchedSaleLine: { findMany } } as any, { failedJobs } as any);
    const result = await controller.list(manager('centro') as any, 'centro');
    const { take, orderBy } = (findMany.mock.calls[0] as any)[0];
    return { take, orderBy, data: result.data as unknown[] };
  };

  test('a fixed number, newest first, with failed matches', async () => {
    assert({
      given: 'pending lines, one whose match the worker gave up on',
      should: 'list at most 200, newest first, showing why that match failed',
      actual: await pending(),
      expected: {
        take: 200,
        orderBy: { sale: { createdAt: 'desc' } },
        data: [
          { id: 'l-1', matchError: null },
          { id: 'l-2', matchError: { productId: 'crema', error: 'Crema no tiene costo', failedAt: new Date(5) } },
        ],
      },
    });
  });
});
