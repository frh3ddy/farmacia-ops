import { Queue } from 'bullmq';
import { assert } from 'riteway/vitest';
import { FAILED_JOB_RETENTION_SECONDS, SaleQueue } from './sale.queue';

vi.mock('ioredis', () => ({ default: vi.fn() }));
vi.mock('bullmq', () => ({ Queue: vi.fn() }));

describe('SaleQueue', () => {
  // Regression: removeOnFail: true deleted a sale that failed every attempt
  // (e.g. unmapped Square item), leaving no record to inspect or replay.
  test('failed job retention', () => {
    new SaleQueue();
    const [name, opts] = vi.mocked(Queue).mock.calls[0] as [string, any];

    assert({
      given: 'a new sale queue',
      should: 'keep a sale that failed every attempt for 30 days instead of deleting it',
      actual: { name, removeOnFail: opts.defaultJobOptions.removeOnFail },
      expected: { name: 'sales', removeOnFail: { age: 30 * 24 * 60 * 60 } },
    });
    assert({
      given: 'the exported retention',
      should: 'match what the queue is configured with',
      actual: FAILED_JOB_RETENTION_SECONDS,
      expected: opts.defaultJobOptions.removeOnFail.age,
    });
  });
});
