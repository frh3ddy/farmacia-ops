import { salesMismatches, type SalesCheckInput } from './sales-check';

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
