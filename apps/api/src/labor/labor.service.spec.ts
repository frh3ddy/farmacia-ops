import { assert } from 'riteway/vitest';
import { SquareError } from 'square';
import { LaborService } from './labor.service';

/** A timecard as Square returns it: location-offset times, wage in minor units. */
const timecard = (id: string, startAt: string, endAt: string | null, amount = 5000, locationId = 'L1') => ({
  id,
  locationId,
  teamMemberId: 'tm-1',
  startAt,
  endAt,
  status: endAt ? 'CLOSED' : 'OPEN',
  version: 3,
  wage: { title: 'Cajera', hourlyRate: { amount: BigInt(amount), currency: 'MXN' } },
});

/** Our stores, mapped to Square locations L1 and L2. */
const stores = [
  { id: 'lolita', squareId: 'L1', name: 'Lolita' },
  { id: 'oriente', squareId: 'L2', name: 'Oriente' },
];

/** The service over a recorded Square labor client and our two stores. */
function laborWith(labor: Record<string, ReturnType<typeof vi.fn>>) {
  const prisma = { location: { findMany: vi.fn().mockResolvedValue(stores) } };
  const service = new LaborService(prisma as any);
  service['squareClient'] = { labor } as any;
  return service;
}

const period = { startDate: '2026-10-19', endDate: '2026-10-25' };

describe('LaborService.getPayrollSummary', () => {
  test('timecards over two pages', async () => {
    const searchTimecards = vi.fn()
      .mockResolvedValueOnce({ timecards: [timecard('tc-1', '2026-10-20T09:00:00-06:00', '2026-10-20T17:30:00-06:00')], cursor: 'next' })
      .mockResolvedValueOnce({ timecards: [timecard('tc-2', '2026-10-21T09:00:00-06:00', '2026-10-21T13:00:00-06:00')] });
    const summary = await laborWith({ searchTimecards }).getPayrollSummary('tm-1', period);

    assert({
      given: "a team member's week of timecards split over two pages",
      should: 'total every page: 12.5 hours over 2 days at $50/h',
      actual: [summary.totalHours, summary.totalMinutes, summary.workedDays, summary.totalCost, summary.currency, summary.shifts.map((s) => s.shiftId)],
      expected: [12, 30, 2, 625, 'MXN', ['tc-1', 'tc-2']],
    });
    assert({
      given: 'the same summary',
      should: 'ask Square for timecards that start in the period, in Mexico City days, oldest first, following the cursor',
      actual: searchTimecards.mock.calls.map(([r]) => r),
      expected: [
        {
          query: {
            filter: {
              teamMemberIds: ['tm-1'],
              workday: { dateRange: period, matchTimecardsBy: 'START_AT', defaultTimezone: 'America/Mexico_City' },
            },
            sort: { field: 'START_AT', order: 'ASC' },
          },
          limit: 200,
        },
        {
          query: {
            filter: {
              teamMemberIds: ['tm-1'],
              workday: { dateRange: period, matchTimecardsBy: 'START_AT', defaultTimezone: 'America/Mexico_City' },
            },
            sort: { field: 'START_AT', order: 'ASC' },
          },
          limit: 200,
          cursor: 'next',
        },
      ],
    });
  });

  test('shifts at two stores', async () => {
    // 7 minutes at $50/h is $5.8333…, so each shift rounds to $5.83 and three of them
    // total $17.49, where 21 minutes rounded once would say $17.50.
    const searchTimecards = vi.fn().mockResolvedValueOnce({
      timecards: [
        timecard('tc-1', '2026-10-20T09:00:00-06:00', '2026-10-20T09:07:00-06:00', 5000, 'L1'),
        timecard('tc-2', '2026-10-21T09:00:00-06:00', '2026-10-21T09:07:00-06:00', 5000, 'L2'),
        timecard('tc-3', '2026-10-22T09:00:00-06:00', '2026-10-22T09:07:00-06:00', 5000, 'L2'),
      ],
    });
    const summary = await laborWith({ searchTimecards }).getPayrollSummary('tm-1', period);

    assert({
      given: 'shifts worked at two stores',
      should: 'name the store of each shift',
      actual: summary.shifts.map((s) => [s.shiftId, s.locationId, s.locationName, s.cost]),
      expected: [['tc-1', 'lolita', 'Lolita', 5.83], ['tc-2', 'oriente', 'Oriente', 5.83], ['tc-3', 'oriente', 'Oriente', 5.83]],
    });
    assert({
      given: 'the same shifts',
      should: 'subtotal each store from its rounded shifts, and total the stores',
      actual: [summary.stores, summary.totalCost],
      expected: [
        [
          { locationId: 'lolita', locationName: 'Lolita', workedMinutes: 7, cost: 5.83 },
          { locationId: 'oriente', locationName: 'Oriente', workedMinutes: 14, cost: 11.66 },
        ],
        17.49,
      ],
    });
  });

  test('a shift at a Square location that is not one of our stores', async () => {
    const searchTimecards = vi.fn().mockResolvedValueOnce({
      timecards: [timecard('tc-1', '2026-10-20T09:00:00-06:00', '2026-10-20T10:00:00-06:00', 5000, 'L-OTHER')],
    });
    const summary = await laborWith({ searchTimecards }).getPayrollSummary('tm-1', period);

    assert({
      given: 'a timecard at a Square location we have no store for',
      should: 'keep its hours and cost in the total, under no store',
      actual: [summary.stores, summary.totalCost],
      expected: [[{ locationId: null, locationName: null, workedMinutes: 60, cost: 50 }], 50],
    });
  });

  test('one store asked for', async () => {
    const searchTimecards = vi.fn().mockResolvedValueOnce({
      timecards: [timecard('tc-2', '2026-10-21T09:00:00-06:00', '2026-10-21T10:00:00-06:00', 5000, 'L2')],
    });
    const summary = await laborWith({ searchTimecards }).getPayrollSummary('tm-1', { ...period, locationId: 'oriente' });

    assert({
      given: 'a summary for one store',
      should: "ask Square only for that store's timecards",
      actual: [searchTimecards.mock.calls[0][0].query.filter.locationIds, summary.stores.map((s) => s.locationId)],
      expected: [['L2'], ['oriente']],
    });
  });

  test('a store that does not exist', async () => {
    const searchTimecards = vi.fn();
    const status = await laborWith({ searchTimecards }).getPayrollSummary('tm-1', { ...period, locationId: 'nowhere' })
      .then(() => undefined, (e) => e.getStatus?.());

    assert({
      given: 'a store id we do not have',
      should: 'answer not found without asking Square',
      actual: [status, searchTimecards.mock.calls.length],
      expected: [404, 0],
    });
  });

  test('a period with no timecards', async () => {
    const searchTimecards = vi.fn()
      .mockResolvedValueOnce({ timecards: [] })
      .mockResolvedValueOnce({ timecards: [timecard('tc-9', '2026-09-01T09:00:00-06:00', '2026-09-01T10:00:00-06:00')] });
    const summary = await laborWith({ searchTimecards }).getPayrollSummary('tm-1', period);

    assert({
      given: 'no timecards in the period',
      should: 'answer zero hours and probe the latest timecards without the period filter',
      actual: [summary.totalWorkedMinutes, summary.shifts, searchTimecards.mock.calls[1][0]],
      expected: [0, [], { query: { filter: { teamMemberIds: ['tm-1'] }, sort: { field: 'START_AT', order: 'DESC' } }, limit: 10 }],
    });
  });
});

const notFound = () => new SquareError({ message: 'Not found', statusCode: 404 });

describe('LaborService.updateShiftTimes', () => {
  test('a new end time', async () => {
    const current = timecard('tc-1', '2026-10-20T09:00:00-06:00', '2026-10-20T17:30:00-06:00');
    const retrieveTimecard = vi.fn().mockResolvedValue({ timecard: current });
    const updateTimecard = vi.fn(async ({ timecard: t }: any) => ({ timecard: { ...t, version: 4 } }));
    const updated = await laborWith({ retrieveTimecard, updateTimecard }).updateShiftTimes('tc-1', { endAt: '2026-10-20T15:00:00-06:00' });

    assert({
      given: 'a corrected end time for a timecard',
      should: "send the timecard back with only its end changed and its current version, and return the new hours",
      actual: [updateTimecard.mock.calls[0][0], updated.hours, updated.shiftId],
      expected: [{ id: 'tc-1', timecard: { ...current, endAt: '2026-10-20T15:00:00-06:00' } }, 6, 'tc-1'],
    });
  });

  test('an id Square does not know', async () => {
    const retrieveTimecard = vi.fn().mockRejectedValue(notFound());
    const status = await laborWith({ retrieveTimecard, updateTimecard: vi.fn() })
      .updateShiftTimes('nope', { endAt: '2026-10-20T15:00:00-06:00' })
      .then(() => 200, (e: any) => e.getStatus());

    assert({ given: 'an unknown timecard id', should: 'answer 404, not 502', actual: status, expected: 404 });
  });
});

describe('LaborService.deleteShift', () => {
  test('a timecard', async () => {
    const deleteTimecard = vi.fn().mockResolvedValue({});
    await laborWith({ deleteTimecard }).deleteShift('tc-1');

    assert({ given: 'a timecard id', should: 'delete that timecard', actual: deleteTimecard.mock.calls, expected: [[{ id: 'tc-1' }]] });
  });

  test('an id Square does not know', async () => {
    const deleteTimecard = vi.fn().mockRejectedValue(notFound());
    const status = await laborWith({ deleteTimecard }).deleteShift('nope').then(() => 200, (e: any) => e.getStatus());

    assert({ given: 'an unknown timecard id', should: 'answer 404, not 502', actual: status, expected: 404 });
  });
});

describe('LaborService.listTeamMembers', () => {
  /** The service over recorded Square team members and our stores: Lolita and Oriente open, Centro closed. */
  const teamWith = (teamMembers: object[]) => {
    const prisma = { location: { findMany: vi.fn().mockResolvedValue([...stores.map((s) => ({ ...s, isActive: true })), { id: 'centro', squareId: 'L3', name: 'Centro', isActive: false }]) } };
    const service = new LaborService(prisma as any);
    service['squareClient'] = { teamMembers: { search: vi.fn().mockResolvedValue({ teamMembers }) } } as any;
    return service;
  };
  const member = (id: string, assignedLocations?: object) => ({ id, givenName: id, familyName: '', status: 'ACTIVE', assignedLocations });

  test('assigned stores', async () => {
    const members = await teamWith([
      member('ana', { assignmentType: 'EXPLICIT_LOCATIONS', locationIds: ['L2', 'L3', 'L-not-ours'] }),
      member('beto', { assignmentType: 'ALL_CURRENT_AND_FUTURE_LOCATIONS' }),
      member('caro'),
    ]).listTeamMembers();

    assert({
      given: 'a member assigned some Square locations, one assigned all, and one with none',
      should: "list each one's open stores of ours, by our id and name",
      actual: members.map((m) => [m.id, m.locations]),
      expected: [
        ['ana', [{ locationId: 'oriente', locationName: 'Oriente' }]],
        ['beto', [{ locationId: 'lolita', locationName: 'Lolita' }, { locationId: 'oriente', locationName: 'Oriente' }]],
        ['caro', []],
      ],
    });
  });
});
