import { runIntegrityChecks, type IntegrityDeps } from './integrity-run';

const now = new Date('2026-10-27T09:00:00Z'); // 03:00 in Mexico City
const hours = (h: number) => h * 3_600_000;

function deps(overrides: Partial<IntegrityDeps> = {}) {
  const saved: any[] = [];
  const lines: string[] = [];
  const d: IntegrityDeps = {
    books: jest.fn().mockResolvedValue([]),
    sales: jest.fn().mockResolvedValue([]),
    fifo: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (run) => void saved.push(run)),
    log: (line) => void lines.push(line),
    ...overrides,
  };
  return { d, saved, lines };
}

describe('runIntegrityChecks', () => {
  it('given clean books, sales and FIFO, saves a run with every check ok and logs one summary line', async () => {
    const { d, saved, lines } = deps();
    await runIntegrityChecks(d, now);

    expect(saved).toEqual([
      {
        ranAt: now,
        mismatchCount: 0,
        checks: {
          books: { status: 'ok', mismatches: [] },
          sales: { status: 'ok', mismatches: [] },
          fifo: { status: 'ok', mismatches: [] },
        },
      },
    ]);
    expect(lines).toEqual(['[INTEGRITY] books ok (0) · sales ok (0) · fifo ok (0)']);
  });

  it('checks sales from 48 h back up to 30 min before the run, and FIFO over the last 48 h', async () => {
    const { d } = deps();
    await runIntegrityChecks(d, now);

    expect(d.sales).toHaveBeenCalledWith({ from: new Date(now.getTime() - hours(48)), cutoff: new Date(now.getTime() - hours(0.5)) });
    expect(d.fifo).toHaveBeenCalledWith({ from: new Date(now.getTime() - hours(48)), to: now });
  });

  it('given mismatches, counts them and logs one line per mismatch', async () => {
    const lost = { kind: 'lost', paymentId: 'p-1', locationId: 'centro', createdAt: '2026-10-26T18:00:00Z' };
    const { d, saved, lines } = deps({ sales: jest.fn().mockResolvedValue([lost]) });
    await runIntegrityChecks(d, now);

    expect(saved[0].mismatchCount).toBe(1);
    expect(saved[0].checks.sales).toEqual({ status: 'ok', mismatches: [lost] });
    expect(lines).toEqual(['[INTEGRITY] books ok (0) · sales ok (1) · fifo ok (0)', `[INTEGRITY] sales ${JSON.stringify(lost)}`]);
  });

  it('given Square unreachable, records the sales check as failed and still runs the other checks', async () => {
    const { d, saved, lines } = deps({ sales: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) });
    await runIntegrityChecks(d, now);

    expect(saved[0].checks.sales).toEqual({ status: 'failed', error: 'ETIMEDOUT', mismatches: [] });
    expect(saved[0].checks.books.status).toBe('ok');
    expect(saved[0].checks.fifo.status).toBe('ok');
    expect(lines[0]).toBe('[INTEGRITY] books ok (0) · sales failed (ETIMEDOUT) · fifo ok (0)');
  });
});
