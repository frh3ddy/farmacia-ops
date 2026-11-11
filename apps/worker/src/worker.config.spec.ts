import type { Job, Queue } from 'bullmq';
import { WORKERS } from './worker.config';
import { processMatchJob, processRefundJob, processReturnJob, processSaleJob } from './sale.worker';

jest.mock('./sale.worker', () => ({ getPrisma: jest.fn(), processSaleJob: jest.fn(), processMatchJob: jest.fn(), processReturnJob: jest.fn(), processRefundJob: jest.fn() }));

describe('WORKERS', () => {
  const integrity = WORKERS.find((w) => w.queueName === 'integrity');

  it('given the integrity job, runs it nightly at 03:00 Mexico City time', () => {
    expect(integrity?.schedule).toEqual({ pattern: '0 3 * * *', tz: 'America/Mexico_City' });
  });

  it('given a failed integrity run, does not retry it (the next night runs again)', () => {
    expect(integrity?.options?.attempts).toBe(1);
    expect(integrity?.concurrency).toBe(1);
  });

  it('given a sales-queue job, runs matches, returns and Square refunds by name and anything else as a sale', async () => {
    const sales = WORKERS.find((w) => w.queueName === 'sales')!;
    const run = (name: string) => sales.processor({ id: name, name, data: {} } as Job, () => ({}) as Queue);

    await run('match-sale-line');
    await run('record-return');
    await run('square-refund');
    await run('process-sale');

    expect([processMatchJob, processReturnJob, processRefundJob, processSaleJob].map((fn) => jest.mocked(fn).mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  describe('stock-days', () => {
    const stockDays = WORKERS.find((w) => w.queueName === 'stock-days');
    const env = process.env;
    beforeEach(() => {
      process.env = { ...env, API_INTERNAL_URL: 'http://api.test', WORKER_API_SECRET: 's3cret' };
    });
    afterEach(() => {
      process.env = env;
    });

    it('given the stock-days job, runs it nightly at 03:00 Mexico City time, once (a missed night is filled by the next)', () => {
      expect([stockDays?.schedule, stockDays?.options?.attempts, stockDays?.concurrency]).toEqual([{ pattern: '0 3 * * *', tz: 'America/Mexico_City' }, 1, 1]);
    });

    it('given a run, asks the api to store the missing stock days with the worker secret', async () => {
      const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, data: { saved: 3 } })));

      await stockDays!.processor({ id: '1', name: 'stock-days', data: {} } as Job, () => ({}) as Queue);

      expect([fetch.mock.calls[0][0], (fetch.mock.calls[0][1] as RequestInit).method, ((fetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>)['x-worker-secret']])
        .toEqual(['http://api.test/internal/stock-alerts/stock-days', 'POST', 's3cret']);
      fetch.mockRestore();
    });

    it('given the api refuses, fails the run so it is recorded', async () => {
      const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('no', { status: 401 }));

      await expect(stockDays!.processor({ id: '1', name: 'stock-days', data: {} } as Job, () => ({}) as Queue)).rejects.toThrow('401');
      fetch.mockRestore();
    });
  });
});
