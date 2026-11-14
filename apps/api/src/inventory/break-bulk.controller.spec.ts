import { assert } from 'riteway/vitest';
import { BreakBulkController } from './break-bulk.controller';

/** A request from an employee whose session is at `at`, with that store's role. */
const requestAt = (role: string, at = 'centro') => ({ employee: { id: 'emp-1' }, currentLocation: { locationId: at, role, isActive: true } }) as never;

const routes = () => {
  const service = { breakBulk: vi.fn(async (_input: { locationId: string }) => ({ looseUnitsCreated: 20 })), automaticOpenings: vi.fn(async (_locationId: string) => []) };
  return { service, controller: new BreakBulkController(service as never) };
};

const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: { getStatus: () => number }) => e.getStatus());

describe('BreakBulkController', () => {
  test('opening boxes at another store', async () => {
    const { controller, service } = routes();

    assert({
      given: 'a manager opening boxes at a store other than their session\'s',
      should: 'refuse with 403 and open nothing',
      actual: [await statusOf(controller.breakBulk({ boxProductId: 'p-1', boxQuantity: 1, locationId: 'oriente' }, requestAt('MANAGER'))), service.breakBulk.mock.calls.length],
      expected: [403, 0],
    });
  });

  test('an owner at another store', async () => {
    const { controller, service } = routes();
    await controller.breakBulk({ boxProductId: 'p-1', boxQuantity: 1, locationId: 'oriente' }, requestAt('OWNER'));
    await controller.automatic('oriente', requestAt('OWNER'));

    assert({
      given: 'an owner opening boxes and reading the openings at another store',
      should: 'do both at that store',
      actual: [service.breakBulk.mock.calls[0][0].locationId, service.automaticOpenings.mock.calls[0]],
      expected: ['oriente', ['oriente']],
    });
  });

  test('openings without a store', async () => {
    const { controller, service } = routes();
    await controller.automatic(undefined, requestAt('MANAGER'));

    assert({
      given: 'a manager reading the boxes sales opened without naming a store',
      should: 'read their session\'s store',
      actual: service.automaticOpenings.mock.calls[0],
      expected: ['centro'],
    });
  });

  test('openings at another store', async () => {
    const { controller, service } = routes();

    assert({
      given: 'a manager reading the boxes sales opened at a store other than their session\'s',
      should: 'refuse with 403',
      actual: [await statusOf(controller.automatic('oriente', requestAt('MANAGER'))), service.automaticOpenings.mock.calls.length],
      expected: [403, 0],
    });
  });
});
