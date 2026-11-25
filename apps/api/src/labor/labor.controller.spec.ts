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

describe('LaborController.getActiveShifts store scope', () => {
  /** The store each request reads, or the refusal's status. */
  const activeFor = async (role: string, locationId?: string) => {
    const getActiveShifts = vi.fn().mockResolvedValue([]);
    const controller = new LaborController({ getActiveShifts } as any);
    const here = { locationId: 'lolita', role, isActive: true };
    const req = { currentLocation: here, accessibleLocations: [here] } as any; // fixture: only the fields the controller reads
    return controller.getActiveShifts(req, locationId).then(() => getActiveShifts.mock.calls[0][0], (e) => e.getStatus?.());
  };

  test('a manager and the owner', async () => {
    assert({
      given: 'a manager naming no store, a manager naming another, and the owner with and without one',
      should: "show the manager their own store only, and the owner every store or the one named",
      actual: [await activeFor('MANAGER'), await activeFor('MANAGER', 'oriente'), await activeFor('OWNER'), await activeFor('OWNER', 'oriente')],
      expected: ['lolita', 403, undefined, 'oriente'],
    });
  });
});

describe('LaborController.listTeamMembers store scope', () => {
  const at = (...ids: string[]) => ids.map((id) => ({ locationId: id, locationName: id.toUpperCase() }));
  const members = [
    { id: 'ana', fullName: 'Ana', locations: at('centro') },
    { id: 'beto', fullName: 'Beto', locations: at('norte') },
    { id: 'caro', fullName: 'Caro', locations: at('centro', 'norte') },
  ];
  const listAs = (role: string) => {
    const controller = new LaborController({ listTeamMembers: vi.fn().mockResolvedValue(members) } as any);
    const here = { locationId: 'centro', role, isActive: true };
    const formerlyNorte = { locationId: 'norte', role, isActive: false };
    return controller.listTeamMembers({ currentLocation: here, accessibleLocations: [here, formerlyNorte] } as any);
  };

  test('a manager', async () => {
    const { data, count } = await listAs('MANAGER');
    assert({
      given: 'a Centro manager (no longer at Norte), a Norte-only member, and a member of both stores',
      should: "list only Centro's staff, each showing only Centro",
      actual: [count, data.map((m: any) => [m.id, m.locations.map((l: any) => l.locationId)])],
      expected: [2, [['ana', ['centro']], ['caro', ['centro']]]],
    });
  });

  test('the owner and the accountant', async () => {
    assert({
      given: 'the owner and an accountant',
      should: 'list every member with all their stores, as before',
      actual: [(await listAs('OWNER')).data, (await listAs('ACCOUNTANT')).data],
      expected: [members, members],
    });
  });
});
