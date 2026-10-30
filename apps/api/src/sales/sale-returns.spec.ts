import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { assert } from 'riteway/vitest';
import { SaleReturnsController } from './sale-returns.controller';
import { ROLES_KEY } from '../auth/guards/auth.guard';

// A sale at Centro: 2 jarabes, one already returned.
const sale = { id: 's-1', locationId: 'centro', items: [{ id: 'si-jarabe', quantity: 2, returns: [{ quantity: 1 }], product: { name: 'Jarabe' } }] };
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
      given: 'another location, a missing sale, more than is left, the same item twice, an item not on the sale, no items, or no request key',
      should: 'refuse without queueing',
      actual: [
        await record({ request: cashier('norte') }),
        await record({ found: null }),
        await record({ payload: body([{ saleItemId: 'si-jarabe', quantity: 2 }]) }),
        await record({ payload: body([{ saleItemId: 'si-jarabe', quantity: 1 }, { saleItemId: 'si-jarabe', quantity: 1 }]) }),
        await record({ payload: body([{ saleItemId: 'si-other', quantity: 1 }]) }),
        await record({ payload: body([]) }),
        await record({ payload: body([{ saleItemId: 'si-jarabe', quantity: 1 }], { clientRequestId: undefined }) }),
      ],
      expected: [
        [403, 'No tienes acceso a esta sucursal'],
        [404, 'Venta no encontrada'],
        [400, 'Solo quedan 1 de Jarabe por devolver'],
        [400, 'Solo quedan 1 de Jarabe por devolver'],
        [400, 'Ese artículo no es de esta venta'],
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

describe('recent sales to return from', () => {
  const recent = async (days?: string) => {
    const findMany = vi.fn(async () => []);
    const controller = new SaleReturnsController({ sale: { findMany } } as any, {} as any);
    const before = Date.now();
    await controller.recent({ currentLocation: { locationId: 'centro', role: 'OWNER' }, accessibleLocations: [] } as any, 'centro', days);
    const { where, take, orderBy } = (findMany.mock.calls[0] as any)[0];
    return { days: Math.round((before - where.createdAt.gte.getTime()) / 86_400_000), take, orderBy };
  };

  test('the window and the limit', async () => {
    assert({
      given: 'no days, 7, 30, zero and a negative number',
      should: 'look back 3 days by default and at most 14, newest first and at most 200 sales',
      actual: [await recent(), await recent('7'), await recent('30'), await recent('0'), await recent('-5')],
      expected: [3, 7, 14, 3, 3].map((days) => ({ days, take: 200, orderBy: { createdAt: 'desc' } })),
    });
  });
});

describe('the returns history', () => {
  const owner = { currentLocation: { locationId: 'centro', role: 'OWNER' }, accessibleLocations: [] };
  const at = (iso: string) => new Date(iso);
  // Two returns by hand at Centro on Oct 30 (Mexico City), one the night before, and one Square paid back.
  const handReturns = [
    { returnedAt: at('2026-10-30T15:00:00Z'), cashRefunded: new Prisma.Decimal(45), sale: { location: { name: 'Centro' } } },
    { returnedAt: at('2026-10-31T05:00:00Z'), cashRefunded: new Prisma.Decimal(15.5), sale: { location: { name: 'Centro' } } },
    { returnedAt: at('2026-10-30T05:00:00Z'), cashRefunded: new Prisma.Decimal(20), sale: { location: { name: 'Centro' } } },
  ];
  const failedJobs = [
    { id: 'j-1', data: { saleId: 's-1', clientRequestId: 'req-ok', items: [] }, failedReason: 'Square is down', finishedOn: 1 },
    { id: 'j-2', data: { saleId: 's-2', clientRequestId: 'req-lost', items: [{ saleItemId: 'si-1', quantity: 1 }], reason: 'Roto' }, failedReason: 'Sale validation error: Solo quedan 0 de Jarabe por devolver', finishedOn: 2 },
  ];
  const history = async () => {
    const prisma = {
      saleReturn: {
        // only req-ok was recorded: its Square sync failed afterwards, which the history already shows
        findMany: async (args: any) => (args.where?.clientRequestId ? [{ clientRequestId: 'req-ok' }] : args.where?.cashRefunded ? handReturns : []),
      },
      employee: { findMany: async () => [] },
    };
    const controller = new SaleReturnsController(prisma as any, { failedJobs: async (name: string) => (name === 'record-return' ? failedJobs : []) } as any);
    return (await controller.list(owner as any, undefined)) as any;
  };

  test('cash paid back by day', async () => {
    assert({
      given: 'returns by hand on two Mexico City days at one store',
      should: 'total the cash paid back per day and store, newest day first',
      actual: (await history()).cashByDay,
      expected: [
        { day: '2026-10-30', location: 'Centro', cash: '60.5' },
        { day: '2026-10-29', location: 'Centro', cash: '20' },
      ],
    });
  });

  test('returns the worker gave up on', async () => {
    assert({
      given: 'a failed return job never recorded, and one recorded whose Square sync failed',
      should: 'list only the one never recorded, with its reason in Spanish',
      actual: (await history()).failed,
      expected: [{ jobId: 'j-2', saleId: 's-2', items: [{ saleItemId: 'si-1', quantity: 1 }], reason: 'Roto', error: 'Solo quedan 0 de Jarabe por devolver', failedAt: new Date(2) }],
    });
  });
});
