import { Queue } from 'bullmq';
import { FAILED_JOB_RETENTION_SECONDS, SaleQueue } from './sale.queue';

jest.mock('ioredis', () => jest.fn());
jest.mock('bullmq', () => ({ Queue: jest.fn() }));

describe('SaleQueue', () => {
  // Regression: removeOnFail: true deleted a sale that failed every attempt
  // (e.g. unmapped Square item), leaving no record to inspect or replay.
  it('keeps failed sale jobs for 30 days instead of deleting them', () => {
    new SaleQueue();

    const [name, opts] = jest.mocked(Queue).mock.calls[0] as [string, any];
    expect(name).toBe('sales');
    expect(opts.defaultJobOptions.removeOnFail).toEqual({ age: FAILED_JOB_RETENTION_SECONDS });
    expect(FAILED_JOB_RETENTION_SECONDS).toBe(2_592_000);
  });
});
