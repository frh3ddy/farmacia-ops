import { assert } from 'riteway/vitest';
import { ROLES_KEY } from '../auth/guards/auth.guard';
import { StockCountController } from './stock-count.controller';

/** The roles AuthGuard requires for a handler. */
const roles = (handler: keyof StockCountController) =>
  Reflect.getMetadata(ROLES_KEY, StockCountController.prototype[handler]);

describe('StockCountController roles', () => {
  test('who may run a Conteo inicial', () => {
    assert({
      given: 'a manager',
      should: 'be forbidden to start, end, list uncounted or zero, but allowed to read and count',
      actual: (['start', 'end', 'uncounted', 'zero', 'active', 'recordCount'] as const).map((h) => roles(h).includes('MANAGER')),
      expected: [false, false, false, false, true, true],
    });
  });
});

describe('StockCountController.recordCount', () => {
  test('a count sent for the session’s store', async () => {
    const counts = { recordCount: vi.fn().mockResolvedValue({ entry: {}, adjustment: null, squareSync: undefined }) };
    const controller = new StockCountController(counts as any);
    const req = { employee: { id: 'e1' }, currentLocation: { role: 'MANAGER', locationId: 'lolita' } } as any;

    await controller.recordCount('c1', { productId: 'p1', countedQuantity: 3 }, req);

    assert({
      given: 'no locationId in the body',
      should: 'count at the session’s store, as the employee',
      actual: counts.recordCount.mock.calls[0],
      expected: ['c1', { locationId: 'lolita', productId: 'p1', countedQuantity: 3, unitCost: undefined, countedBy: 'e1', clientRequestId: undefined }],
    });
  });
});

describe('StockCountController another store', () => {
  test('a manager here who is only a cashier at Norte', async () => {
    const counts = { recordCount: vi.fn(), active: vi.fn() };
    const controller = new StockCountController(counts as any);
    const req = { employee: { id: 'e1' }, currentLocation: { role: 'MANAGER', locationId: 'centro' } } as any;
    const refusal = (p: Promise<unknown>) => p.then(() => 'done', (e: Error) => e.message);

    assert({
      given: 'a count or a session read sent for Norte from a Centro manager session',
      should: 'refuse both and count nothing',
      actual: [
        await refusal(controller.recordCount('c1', { locationId: 'norte', productId: 'p1', countedQuantity: 0 }, req)),
        await refusal(controller.active('norte', req)),
        counts.recordCount.mock.calls.length,
      ],
      expected: ['Solo el dueño puede hacer esto en otras sucursales', 'Solo el dueño puede hacer esto en otras sucursales', 0],
    });
  });
});

