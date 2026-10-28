import { assert } from 'riteway/vitest';
import { Prisma } from '@prisma/client';
import { InventoryAdjustmentService } from './inventory-adjustment.service';

const errorOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

describe('createAdjustment effectiveDate', () => {
  const service = new InventoryAdjustmentService({
    product: { findUnique: async () => ({ id: 'p1', name: 'P' }) },
    location: { findUnique: async () => ({ id: 'l1' }) },
    cutoverLock: { findFirst: async () => ({ id: 'lock' }) },
  } as any);
  const input = { locationId: 'l1', productId: 'p1', type: 'FOUND' as const, quantity: 1, unitCost: 1 };

  test('a future date', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    assert({
      given: 'an effectiveDate tomorrow',
      should: 'reject it',
      actual: await errorOf(() => service.createAdjustment({ ...input, effectiveDate: tomorrow })),
      expected: 'Adjustment effectiveDate cannot be in the future',
    });
  });

  test('today at noon or a past date', async () => {
    const noonToday = new Date();
    noonToday.setHours(12, 0, 0, 0);
    // The cutover lock stub always locks, so reaching it means the date check passed.
    assert({
      given: 'a date-only "today" (parsed as noon)',
      should: 'pass the date check',
      actual: (await errorOf(() => service.createAdjustment({ ...input, effectiveDate: noonToday })))?.startsWith('Cannot make adjustments'),
      expected: true,
    });
  });
});

describe('createAdjustment removal race', () => {
  test('stock taken between the read and the decrement', async () => {
    const consumptions = vi.fn();
    const tx = {
      inventory: {
        findMany: async () => [{ id: 'b1', quantity: 5, unitCost: new Prisma.Decimal(2) }],
        // Someone else took the stock first: the conditional decrement matches nothing.
        updateMany: async () => ({ count: 0 }),
      },
      inventoryAdjustment: { create: async () => ({ id: 'a1' }) },
      inventoryConsumption: { createMany: consumptions },
    };
    const service = new InventoryAdjustmentService({
      product: { findUnique: async () => ({ id: 'p1', name: 'P' }) },
      location: { findUnique: async () => ({ id: 'l1' }) },
      cutoverLock: { findFirst: async () => null },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    } as any);

    assert({
      given: 'a batch emptied by a concurrent write',
      should: 'fail with a retryable conflict and write no consumptions',
      actual: [
        await errorOf(() => service.createAdjustment({ locationId: 'l1', productId: 'p1', type: 'DAMAGE', quantity: -5 })),
        consumptions.mock.calls.length,
      ],
      expected: ['Stock changed while recording this adjustment — please retry', 0],
    });
  });
});

// One 10-unit batch at $3, everything else a pass-through; records what's written.
function serviceWithStock() {
  const created = vi.fn(async ({ data }: any) => ({ id: 'a1', adjustedAt: new Date(), ...data }));
  const tx = {
    inventory: {
      findMany: async () => [{ id: 'b1', quantity: 10, unitCost: new Prisma.Decimal(3) }],
      updateMany: async () => ({ count: 1 }),
      create: async () => ({ id: 'b2' }),
    },
    inventoryAdjustment: { create: created },
    inventoryConsumption: { createMany: async () => ({}) },
  };
  const service = new InventoryAdjustmentService({
    product: { findUnique: async () => ({ id: 'p1', name: 'P' }) },
    location: { findUnique: async () => ({ id: 'l1' }) },
    cutoverLock: { findFirst: async () => null },
    inventory: { aggregate: async () => ({ _sum: { quantity: 10 } }) },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as any);
  return { service, created };
}

const base = { locationId: 'l1', productId: 'p1' };

describe('createAdjustment removal cost', () => {
  test('a unit cost sent with a removal', async () => {
    const { service, created } = serviceWithStock();
    await service.createAdjustment({ ...base, type: 'DAMAGE', quantity: -2, unitCost: 50 });
    const { unitCost, totalCost } = created.mock.calls[0][0].data;

    assert({
      given: 'a removal with a client-supplied unit cost',
      should: 'record the FIFO cost, consistent with the total',
      actual: [unitCost.toString(), totalCost.toString()],
      expected: ['3', '6'],
    });
  });
});

describe('createAdjustment input', () => {
  const rejected = 'Quantity must be a non-zero whole number';

  test('a quantity that is not a whole number', async () => {
    const { service } = serviceWithStock();
    assert({
      given: 'a fractional quantity',
      should: 'refuse it',
      actual: await errorOf(() => service.createAdjustment({ ...base, type: 'FOUND', quantity: 1.5, unitCost: 1 })),
      expected: rejected,
    });
    assert({
      given: 'a quantity sent as text',
      should: 'refuse it',
      actual: await errorOf(() => service.createAdjustment({ ...base, type: 'FOUND', quantity: '5' as any, unitCost: 1 })),
      expected: rejected,
    });
    assert({
      given: 'a missing quantity on a quick route (NaN after sign forcing)',
      should: 'refuse it',
      actual: await errorOf(() => service.createAdjustment({ ...base, type: 'DAMAGE', quantity: NaN })),
      expected: rejected,
    });
  });

  test('a negative unit cost', async () => {
    const { service, created } = serviceWithStock();
    assert({
      given: 'stock added at a negative unit cost',
      should: 'refuse it without writing anything',
      actual: [
        await errorOf(() => service.createAdjustment({ ...base, type: 'FOUND', quantity: 5, unitCost: -3 })),
        created.mock.calls.length,
      ],
      expected: ['Unit cost must be zero or more', 0],
    });
  });

  test('a free item added at zero cost', async () => {
    const { service, created } = serviceWithStock();
    await service.createAdjustment({ ...base, type: 'FOUND', quantity: 5, unitCost: 0 });
    assert({
      given: 'stock added at a unit cost of zero',
      should: 'record it at zero rather than looking a cost up',
      actual: created.mock.calls[0][0].data.unitCost.toString(),
      expected: '0',
    });
  });
});

describe('createAdjustment replay', () => {
  test('the same request arriving twice at once', async () => {
    const winner = {
      id: 'a-first', type: 'FOUND', quantity: 5, productId: 'p1', locationId: 'l1',
      unitCost: new Prisma.Decimal(1), totalCost: new Prisma.Decimal(5),
      reason: null, notes: null, adjustedAt: new Date(), effectiveDate: new Date(),
      createdBatch: { id: 'b-first' }, consumptions: [],
    };
    // The replay's lookup misses (the first copy hasn't committed yet); by the
    // time its insert runs, the first copy owns the clientRequestId.
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(winner);
    const duplicate = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['clientRequestId'] },
    });
    const service = new InventoryAdjustmentService({
      product: { findUnique: async () => ({ id: 'p1', name: 'P' }) },
      location: { findUnique: async () => ({ id: 'l1' }) },
      cutoverLock: { findFirst: async () => null },
      inventory: { aggregate: async () => ({ _sum: { quantity: 5 } }) },
      inventoryAdjustment: { findUnique },
      $transaction: async () => { throw duplicate; },
    } as any);

    const result = await service.createAdjustment({ ...base, type: 'FOUND', quantity: 5, unitCost: 1, clientRequestId: 'req-1' });

    assert({
      given: 'a replay whose insert loses to the first copy on the dedup key',
      should: "return the first copy's adjustment instead of failing",
      actual: result.adjustment.id,
      expected: 'a-first',
    });
  });
});

describe('getAdjustmentSummary', () => {
  test('a count correction that removed stock, and a find that added it back', async () => {
    // Adjustments: COUNT_CORRECTION −20 ($40), FOUND +20 ($40). totalCost is stored positive for both.
    const rows = [
      { type: 'COUNT_CORRECTION', quantity: -20, totalCost: 40 },
      { type: 'FOUND', quantity: 20, totalCost: 40 },
    ];
    const matching = (where: any) => rows.filter((r) =>
      where.quantity?.gt !== undefined ? r.quantity > where.quantity.gt
        : where.quantity?.lt !== undefined ? r.quantity < where.quantity.lt
        : true);
    const service = new InventoryAdjustmentService({
      inventoryAdjustment: {
        aggregate: async ({ where }: any) => {
          const m = matching(where);
          return {
            _count: { id: m.length },
            _sum: {
              quantity: m.length ? m.reduce((s, r) => s + r.quantity, 0) : null,
              totalCost: m.length ? new Prisma.Decimal(m.reduce((s, r) => s + r.totalCost, 0)) : null,
            },
          };
        },
        groupBy: async () => rows.map((r) => ({
          type: r.type, _count: { id: 1 }, _sum: { quantity: r.quantity, totalCost: new Prisma.Decimal(r.totalCost) },
        })),
      },
    } as any);

    const summary = await service.getAdjustmentSummary('l1');

    assert({
      given: 'a stock-removing count correction',
      should: 'count it as a removal, by the sign of its quantity rather than its type',
      actual: [summary.positive.totalQuantity, summary.negative.totalQuantity],
      expected: [20, 20],
    });
    assert({
      given: 'equal cost added and removed',
      should: 'report a net cost impact of zero',
      actual: summary.totals.totalCostImpact,
      expected: '0',
    });
  });
});

describe('getLastKnownCost', () => {
  const costOf = (batch: unknown, supplier: unknown, approval: unknown = null) => {
    const findFirst = (result: unknown) => async () => result;
    const service = new InventoryAdjustmentService({
      inventory: { findFirst: async ({ where }: any) => (where.unitCost?.gt === 0 ? batch : { unitCost: new Prisma.Decimal(0) }) },
      supplierProduct: { findFirst: findFirst(supplier) },
      costApproval: { findFirst: findFirst(approval) },
    } as any);
    return (service as any).getLastKnownCost('p1', 'l1');
  };

  test('a costed batch and a supplier cost', async () => {
    assert({
      given: 'a last batch at this location and a preferred supplier cost',
      should: "use the batch's cost",
      actual: await costOf({ unitCost: new Prisma.Decimal(4) }, { cost: new Prisma.Decimal(9) }),
      expected: 4,
    });
  });

  test('no costed batch', async () => {
    assert({
      given: 'only zero-cost batches and a preferred supplier cost',
      should: "fall back to the supplier's cost",
      actual: await costOf(null, { cost: new Prisma.Decimal(9) }),
      expected: 9,
    });
  });
});
