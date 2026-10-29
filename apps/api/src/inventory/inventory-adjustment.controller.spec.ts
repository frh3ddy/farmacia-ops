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

  test('a very large limit', async () => {
    const { controller, service } = controllerWithList();
    await controller.getAdjustmentsByLocation('centro', undefined, undefined, undefined, '1000000');
    assert({
      given: 'a limit far beyond a page',
      should: 'cap it',
      actual: service.getAdjustmentsByLocation.mock.calls[0][1].limit,
      expected: 500,
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
