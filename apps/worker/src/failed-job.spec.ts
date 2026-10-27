import { describeFailedJob } from './failed-job';

describe('describeFailedJob', () => {
  it('given a failed sale job, names it by ids and error only, never the payment data', () => {
    const job = {
      id: 'evt-1',
      attemptsMade: 5,
      failedReason: 'Sale validation error: Order o-1 not found in Square',
      data: {
        payload: {
          object: {
            payment: { id: 'p-1', buyer_email_address: 'ana@example.com', card_details: { card: { last_4: '4242' } } },
          },
        },
      },
    };

    expect(describeFailedJob(job)).toEqual({
      id: 'evt-1',
      paymentId: 'p-1',
      attemptsMade: 5,
      error: 'Sale validation error: Order o-1 not found in Square',
    });
  });

  it('given an error passed by the failed event, uses its message', () => {
    expect(describeFailedJob({ id: 'evt-2', attemptsMade: 1, data: {} }, new Error('ETIMEDOUT'))).toEqual({
      id: 'evt-2',
      paymentId: undefined,
      attemptsMade: 1,
      error: 'ETIMEDOUT',
    });
  });
});
