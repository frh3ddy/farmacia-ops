import { assert } from 'riteway/vitest';
import { LaborController } from './labor.controller';

/** The controller over a recorded payroll service; requests come from a store's staff. */
function setup() {
  const getPayrollSummary = vi.fn().mockResolvedValue({});
  const controller = new LaborController({ getPayrollSummary } as any);
  const requestAs = (role: string, locationId = 'lolita') => {
    const here = { locationId, role, isActive: true };
    return { currentLocation: here, accessibleLocations: [here] } as any; // fixture: only the fields the controller reads
  };
  const summaryFor = (req: any, locationId?: string) =>
    controller.getPayrollSummary(req, 'tm-1', '2026-10-19', '2026-10-25', undefined, locationId).then(
      () => getPayrollSummary.mock.calls[getPayrollSummary.mock.calls.length - 1]?.[1].locationId,
      (e) => e.getStatus?.(),
    );
  return { requestAs, summaryFor };
}

describe('LaborController.getPayrollSummary store scope', () => {
  test('a manager', async () => {
    const { requestAs, summaryFor } = setup();
    const manager = requestAs('MANAGER');

    assert({
      given: 'a manager who names no store',
      should: 'answer for their own store only',
      actual: await summaryFor(manager),
      expected: 'lolita',
    });
    assert({
      given: 'a manager asking for another store',
      should: 'refuse it',
      actual: await summaryFor(manager, 'oriente'),
      expected: 403,
    });
  });

  test('the owner', async () => {
    const { requestAs, summaryFor } = setup();
    const owner = requestAs('OWNER');

    assert({
      given: 'the owner, with and without a store',
      should: 'answer for every store, or the one named',
      actual: [await summaryFor(owner), await summaryFor(owner, 'oriente')],
      expected: [undefined, 'oriente'],
    });
  });
});
