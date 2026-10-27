import { WORKERS } from './worker.config';

describe('WORKERS', () => {
  const integrity = WORKERS.find((w) => w.queueName === 'integrity');

  it('given the integrity job, runs it nightly at 03:00 Mexico City time', () => {
    expect(integrity?.schedule).toEqual({ pattern: '0 3 * * *', tz: 'America/Mexico_City' });
  });

  it('given a failed integrity run, does not retry it (the next night runs again)', () => {
    expect(integrity?.options?.attempts).toBe(1);
    expect(integrity?.concurrency).toBe(1);
  });
});
