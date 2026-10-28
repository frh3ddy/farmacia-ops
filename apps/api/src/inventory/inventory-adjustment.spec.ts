// What can't run on PGlite (concurrent transactions) or is decided before the
// database is touched. Database behaviour lives in inventory-adjustment.pg.spec.ts.
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

// Input checks run before any query, so a service with no database will do:
// reaching one would fail with a different error.
const noDatabase = () => new InventoryAdjustmentService({} as any);
const base = { locationId: 'l1', productId: 'p1' };

describe('createAdjustment effectiveDate', () => {
  test('a future date', async () => {
    const service = new InventoryAdjustmentService({
      product: { findUnique: async () => ({ id: 'p1' }) },
      location: { findUnique: async () => ({ id: 'l1' }) },
    } as any);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    assert({
      given: 'an effectiveDate tomorrow',
      should: 'reject it',
      actual: await errorOf(() => service.createAdjustment({ ...base, type: 'FOUND', quantity: 1, unitCost: 1, effectiveDate: tomorrow })),
      expected: 'La fecha del ajuste no puede ser futura',
    });
  });
});

describe('createAdjustment input', () => {
  const rejected = 'La cantidad debe ser un número entero distinto de cero';

  test('a quantity that is not a whole number', async () => {
    assert({
      given: 'a fractional quantity',
      should: 'refuse it',
      actual: await errorOf(() => noDatabase().createAdjustment({ ...base, type: 'FOUND', quantity: 1.5, unitCost: 1 })),
      expected: rejected,
    });
    assert({
      given: 'a quantity sent as text',
      should: 'refuse it',
      actual: await errorOf(() => noDatabase().createAdjustment({ ...base, type: 'FOUND', quantity: '5' as any, unitCost: 1 })),
      expected: rejected,
    });
    assert({
      given: 'a missing quantity on a quick route (NaN after sign forcing)',
      should: 'refuse it',
      actual: await errorOf(() => noDatabase().createAdjustment({ ...base, type: 'DAMAGE', quantity: NaN })),
      expected: rejected,
    });
  });

  test('an OTHER adjustment without notes', async () => {
    assert({
      given: 'an adjustment of type OTHER with no notes saying what happened',
      should: 'refuse it',
      actual: await errorOf(() => noDatabase().createAdjustment({ ...base, type: 'OTHER', quantity: -1, notes: '  ' })),
      expected: 'Escribe una nota para un ajuste de tipo Otro',
    });
  });

  test('a very long reason or note', async () => {
    const long = 'x'.repeat(501);
    assert({
      given: 'a reason or note longer than a short paragraph',
      should: 'refuse it',
      actual: [
        await errorOf(() => noDatabase().createAdjustment({ ...base, type: 'DAMAGE', quantity: -1, reason: long })),
        await errorOf(() => noDatabase().createAdjustment({ ...base, type: 'DAMAGE', quantity: -1, notes: long })),
      ],
      expected: Array(2).fill('El motivo y las notas deben tener 500 caracteres o menos'),
    });
  });

  test('a negative unit cost', async () => {
    assert({
      given: 'stock added at a negative unit cost',
      should: 'refuse it before writing anything',
      actual: await errorOf(() => noDatabase().createAdjustment({ ...base, type: 'FOUND', quantity: 5, unitCost: -3 })),
      expected: 'El costo unitario debe ser cero o mayor',
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
      product: { findUnique: async () => ({ id: 'p1' }) },
      location: { findUnique: async () => ({ id: 'l1' }) },
      cutoverLock: { findFirst: async () => ({ cutoverDate: new Date('2026-01-01') }) },
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

  test('no batch or supplier cost', async () => {
    assert({
      given: 'only an approved cutover cost',
      should: 'fall back to it',
      actual: await costOf(null, null, { approvedCost: new Prisma.Decimal(7) }),
      expected: 7,
    });
  });
});
