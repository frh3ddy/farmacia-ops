import { assert } from 'riteway/vitest';
import { InventoryAdjustmentController } from './inventory-adjustment.controller';

// A manager assigned only to "centro".
const managerRequest = () => ({
  employee: { id: 'e1' },
  currentLocation: { role: 'MANAGER', locationId: 'centro' },
  accessibleLocations: [{ locationId: 'centro', isActive: true }],
}) as any; // fixture: only the fields the controller reads

const ownerRequest = () => ({
  employee: { id: 'o1' },
  currentLocation: { role: 'OWNER', locationId: 'centro' },
  accessibleLocations: [],
}) as any;

/** 'done', or the refusal's message. */
const outcome = (promise: Promise<unknown>) => promise.then(() => 'done', (e: any) => e.response?.message ?? e.message);

const adjustmentAt = (locationId: string) => ({
  id: 'a1',
  locationId,
  unitCost: { toString: () => '1' },
  totalCost: { toString: () => '1' },
  consumptions: [],
  createdBatch: null,
});

describe('InventoryAdjustmentController.createAdjustment', () => {
  test('a type only the system writes', async () => {
    const service = { createAdjustment: vi.fn().mockResolvedValue({}) };
    const controller = new InventoryAdjustmentController(service as any);
    const body = { locationId: 'centro', productId: 'p1', type: 'TRANSFER_IN', quantity: 5, unitCost: 1 };

    assert({
      given: 'a transfer, break-bulk or sale-cover type sent by a user',
      should: 'refuse it',
      actual: await outcome(controller.createAdjustment(body as any, managerRequest())),
      expected: 'Invalid adjustment type. Must be one of: DAMAGE, THEFT, EXPIRED, COUNT_CORRECTION, FOUND, RETURN, WRITE_OFF, OTHER',
    });
    assert({
      given: 'a refused type',
      should: 'change no stock',
      actual: service.createAdjustment.mock.calls.length,
      expected: 0,
    });
  });

  test('a type users record', async () => {
    const service = { createAdjustment: vi.fn().mockResolvedValue({}) };
    const controller = new InventoryAdjustmentController(service as any);
    const body = { locationId: 'centro', productId: 'p1', type: 'FOUND', quantity: 5, unitCost: 1 };

    assert({
      given: 'a user-facing type',
      should: 'record the adjustment',
      actual: await outcome(controller.createAdjustment(body as any, managerRequest())),
      expected: 'done',
    });
  });
});

describe('InventoryAdjustmentController.recordCountCorrection', () => {
  test('a counted total', async () => {
    const service = { createAdjustment: vi.fn().mockResolvedValue({ adjustment: { quantity: -3 } }) };
    const controller = new InventoryAdjustmentController(service as any);
    const body = { locationId: 'centro', productId: 'p1', countedQuantity: 12 };

    const response = await controller.recordCountCorrection(body as any, managerRequest());

    assert({
      given: 'a count correction carrying only the counted total',
      should: 'pass the counted total to the service',
      actual: service.createAdjustment.mock.calls[0]?.[0]?.countedQuantity,
      expected: 12,
    });
    assert({
      given: 'the change the server derived',
      should: 'report that change, not the missing client quantity',
      actual: response.message,
      expected: 'Ajuste registrado: Corrección de conteo, 3 unidades',
    });
  });
});

describe('InventoryAdjustmentController.getAdjustmentsByLocation', () => {
  const controllerWithList = () => {
    const service = { getAdjustmentsByLocation: vi.fn().mockResolvedValue([]) };
    return { service, controller: new InventoryAdjustmentController(service as any) };
  };

  test('an unreadable date', async () => {
    const { controller } = controllerWithList();
    assert({
      given: 'a start date that is not a date',
      should: 'refuse the request as a bad request',
      actual: await outcome(controller.getAdjustmentsByLocation('centro', 'not-a-date')),
      expected: 'Invalid startDate format',
    });
    assert({
      given: 'an end date that is not a date',
      should: 'refuse the request as a bad request',
      actual: await outcome(controller.getAdjustmentsByLocation('centro', undefined, 'not-a-date')),
      expected: 'Invalid endDate format',
    });
  });

  test('a date-only range', async () => {
    const { controller, service } = controllerWithList();
    await controller.getAdjustmentsByLocation('centro', '2026-10-01');
    assert({
      given: 'a date-only start date',
      should: 'start at midnight in Mexico City',
      actual: service.getAdjustmentsByLocation.mock.calls[0][1].startDate.toISOString(),
      expected: '2026-10-01T06:00:00.000Z',
    });
  });

  test('a date-only end date', async () => {
    const { controller, service } = controllerWithList();
    await controller.getAdjustmentsByLocation('centro', undefined, '2026-10-01');
    const end: Date = service.getAdjustmentsByLocation.mock.calls[0][1].endDate;
    assert({
      given: 'a date-only end date',
      should: 'include the whole of that day in Mexico City',
      actual: end.toISOString(),
      expected: '2026-10-02T05:59:59.999Z',
    });
  });
});

describe('InventoryAdjustmentController.getAdjustment', () => {
  test("another location's adjustment", async () => {
    const service = { getAdjustment: vi.fn().mockResolvedValue(adjustmentAt('norte')) };
    const controller = new InventoryAdjustmentController(service as any);

    assert({
      given: 'a manager asking for an adjustment at a store they are not assigned to',
      should: 'refuse it',
      actual: await outcome(controller.getAdjustment('a1', managerRequest())),
      expected: 'No tienes acceso a esta sucursal',
    });
  });

  test('own location, or an owner', async () => {
    const service = { getAdjustment: vi.fn().mockResolvedValue(adjustmentAt('norte')) };
    const controller = new InventoryAdjustmentController(service as any);

    assert({
      given: 'an owner asking for any location\'s adjustment',
      should: 'return it',
      actual: await outcome(controller.getAdjustment('a1', ownerRequest())),
      expected: 'done',
    });
  });
});

describe('InventoryAdjustmentController Square sync messages', () => {
  test('found stock saved but not synced to Square', async () => {
    const service = {
      createAdjustment: vi.fn().mockResolvedValue({ adjustment: { quantity: 2 }, squareSync: { synced: false, error: 'fetch failed' } }),
    };
    const controller = new InventoryAdjustmentController(service as any);

    const { message, data } = await controller.createAdjustment(
      { locationId: 'centro', productId: 'p1', type: 'FOUND', quantity: 2, unitCost: 5 } as any,
      managerRequest(),
    );

    assert({
      given: 'found stock that Square could not be reached for',
      should: 'answer in Spanish, naming the type in Spanish, with the short reason',
      actual: [message, data.squareSync?.error],
      expected: [
        'Ajuste registrado: Encontrado, 2 unidades — no se sincronizó con Square: No se pudo conectar con Square; reintenta más tarde. Puedes reintentar desde el historial.',
        'No se pudo conectar con Square; reintenta más tarde',
      ],
    });
  });

  test('a retry Square refuses again', async () => {
    const service = { retrySquareSync: vi.fn().mockResolvedValue({ synced: false, error: 'Location not linked to Square' }) };
    const controller = new InventoryAdjustmentController(service as any);

    const { message, data } = await controller.retrySquareSync('a1');

    assert({
      given: 'a retry for a store not linked to Square',
      should: 'answer with the short Spanish reason in the message and data',
      actual: [message, data.error],
      expected: ['No se sincronizó con Square: La tienda no está conectada a Square', 'La tienda no está conectada a Square'],
    });
  });
});
