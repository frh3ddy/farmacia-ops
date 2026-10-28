import { failedJobPaymentIds, recordedPaymentIds, salesCheckScope, salesMismatches, type SalesCheckInput } from './sales-check';

const cutoff = new Date('2026-10-27T08:30:00Z');

// Centro's payments for the day; p-sold has its Sale.
function input(overrides: Partial<SalesCheckInput> = {}): SalesCheckInput {
  return {
    payments: [{ id: 'p-sold', locationId: 'centro', status: 'COMPLETED', createdAt: '2026-10-26T18:00:00Z' }],
    recordedPaymentIds: new Set(['p-sold']),
    failedJobPaymentIds: new Set(),
    cutoff,
    ...overrides,
  };
}

const payment = (id: string, status = 'COMPLETED', createdAt = '2026-10-26T19:00:00Z') => ({ id, locationId: 'centro', status, createdAt });

describe('salesMismatches', () => {
  it('given every completed payment has its sale, reports nothing', () => {
    expect(salesMismatches(input())).toEqual([]);
  });

  it('given a completed payment with no sale and no failed job, reports it as lost', () => {
    const result = salesMismatches(input({ payments: [...input().payments, payment('p-lost')] }));

    expect(result).toEqual([{ kind: 'lost', paymentId: 'p-lost', locationId: 'centro', createdAt: '2026-10-26T19:00:00Z' }]);
  });

  it('given a completed payment whose sale job failed, reports it as a failed job to replay', () => {
    const result = salesMismatches(input({ payments: [payment('p-failed')], failedJobPaymentIds: new Set(['p-failed']), recordedPaymentIds: new Set() }));

    expect(result).toEqual([{ kind: 'failedJob', paymentId: 'p-failed', locationId: 'centro', createdAt: '2026-10-26T19:00:00Z' }]);
  });

  it('given a payment received after the cutoff, does not report it (it may still be in the queue)', () => {
    const result = salesMismatches(input({ payments: [payment('p-late', 'COMPLETED', '2026-10-27T08:45:00Z')], recordedPaymentIds: new Set() }));

    expect(result).toEqual([]);
  });

  it('given canceled or failed payments with no sale, does not report them (no money was taken)', () => {
    const result = salesMismatches(input({ payments: [payment('p-canceled', 'CANCELED'), payment('p-declined', 'FAILED')], recordedPaymentIds: new Set() }));

    expect(result).toEqual([]);
  });
});

describe('failedJobPaymentIds', () => {
  it('given failed jobs, returns their Square payment ids', () => {
    const job = { data: { payload: { object: { payment: { id: 'p-1' } } } } };
    expect(failedJobPaymentIds([job])).toEqual(new Set(['p-1']));
  });

  it('given an undefined entry (a failed id whose job data is gone), skips it instead of throwing', () => {
    // Regression: production's sales queue returned one undefined failed job,
    // which crashed the worker's startup listing (reading 'id') and would
    // have failed the sales check every night.
    const job = { data: { payload: { object: { payment: { id: 'p-1' } } } } };
    expect(failedJobPaymentIds([undefined, job, { data: {} }])).toEqual(new Set(['p-1']));
  });
});

describe('recordedPaymentIds', () => {
  const prisma = (sales: string[], yastas: string[]) =>
    ({
      sale: { findMany: jest.fn().mockResolvedValue(sales.map((squareId) => ({ squareId }))) },
      yastasOperation: { findMany: jest.fn().mockResolvedValue(yastas.map((squareId) => ({ squareId }))) },
    }) as any;

  it('given a Yastás-only payment, counts its YastasOperation as recorded (it never creates a Sale)', async () => {
    const db = prisma(['p-sold'], ['p-yastas']);

    expect(await recordedPaymentIds(db, ['p-sold', 'p-yastas', 'p-lost'])).toEqual(new Set(['p-sold', 'p-yastas']));
    expect(db.yastasOperation.findMany).toHaveBeenCalledWith({
      where: { squareId: { in: ['p-sold', 'p-yastas', 'p-lost'] } },
      select: { squareId: true },
    });
  });
});

describe('salesCheckScope', () => {
  const window = { from: new Date('2026-11-10T08:30:00Z'), cutoff: new Date('2026-11-12T08:00:00Z') };
  const centro = { id: 'centro', squareId: 'SQ-CENTRO' };
  const norte = { id: 'norte', squareId: 'SQ-NORTE' };
  const lock = (locationId: string | null, cutoverDate: string) => ({ locationId, cutoverDate: new Date(cutoverDate) });
  const scope = (locks: ReturnType<typeof lock>[], startedAt?: string) =>
    salesCheckScope([centro, norte], locks, startedAt, window).map((s) => [s.locationId, s.from.toISOString()]);

  it('given sales recording has not started, checks nothing (no sales are recorded before every cutover)', () => {
    expect(scope([lock('centro', '2026-10-01')])).toEqual([]);
  });

  it('given recording started, checks only cut-over locations, from the latest of window, cutover and start', () => {
    expect(scope([lock('centro', '2026-10-01'), lock('norte', '2026-11-11T12:00:00Z')], '2026-11-01')).toEqual([
      ['centro', '2026-11-10T08:30:00.000Z'],
      ['norte', '2026-11-11T12:00:00.000Z'],
    ]);
    expect(scope([lock('centro', '2026-10-01')], '2026-11-11T15:00:00Z')).toEqual([['centro', '2026-11-11T15:00:00.000Z']]);
  });

  it('given a lock with no location (all locations), covers every location', () => {
    expect(scope([lock(null, '2026-10-01')], '2026-11-01').map(([id]) => id)).toEqual(['centro', 'norte']);
  });

  it('given recording starts after the cutoff, checks nothing yet', () => {
    expect(scope([lock('centro', '2026-10-01')], '2026-11-12T09:00:00Z')).toEqual([]);
  });

  it('given a start that is not a date, fails the check instead of silently checking nothing', () => {
    expect(() => scope([], 'next monday')).toThrow(/SALES_RECORDING_STARTED_AT/);
  });
});
