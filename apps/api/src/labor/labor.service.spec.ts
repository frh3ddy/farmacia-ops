import { assert } from 'riteway/vitest';
import { SquareError } from 'square';
import { LaborService } from './labor.service';

/** A timecard as Square returns it: location-offset times, wage in minor units. */
const timecard = (id: string, startAt: string, endAt: string | null, amount = 5000) => ({
  id,
  locationId: 'L1',
  teamMemberId: 'tm-1',
  startAt,
  endAt,
  status: endAt ? 'CLOSED' : 'OPEN',
  version: 3,
  wage: { title: 'Cajera', hourlyRate: { amount: BigInt(amount), currency: 'MXN' } },
});

/** The service over a recorded Square labor client. */
function laborWith(labor: Record<string, ReturnType<typeof vi.fn>>) {
  const service = new LaborService();
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
