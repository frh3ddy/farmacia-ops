import type { Job, Queue } from 'bullmq';
import { WORKERS } from './worker.config';
import { processMatchJob, processSaleJob } from './sale.worker';

jest.mock('./sale.worker', () => ({ getPrisma: jest.fn(), processSaleJob: jest.fn(), processMatchJob: jest.fn() }));

describe('WORKERS', () => {
  const integrity = WORKERS.find((w) => w.queueName === 'integrity');

  it('given the integrity job, runs it nightly at 03:00 Mexico City time', () => {
    expect(integrity?.schedule).toEqual({ pattern: '0 3 * * *', tz: 'America/Mexico_City' });
  });

  it('given a failed integrity run, does not retry it (the next night runs again)', () => {
    expect(integrity?.options?.attempts).toBe(1);
    expect(integrity?.concurrency).toBe(1);
  });

  it('given a sales-queue job, runs a match job as a match and anything else as a sale', async () => {
    const sales = WORKERS.find((w) => w.queueName === 'sales')!;
    const run = (name: string) => sales.processor({ id: name, name, data: {} } as Job, () => ({}) as Queue);

    await run('match-sale-line');
    await run('process-sale');

    expect([jest.mocked(processMatchJob).mock.calls.length, jest.mocked(processSaleJob).mock.calls.length]).toEqual([1, 1]);
  });
});
