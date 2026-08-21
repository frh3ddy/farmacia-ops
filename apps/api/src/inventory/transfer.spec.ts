import { buildTransferLines, resolveQuantityReceived, discrepancy } from './transfer';

describe('buildTransferLines', () => {
  it('creates one line per consumed batch, preserving cost and date exactly (no blending)', () => {
    const batches = [
      { inventoryId: 'lot-1', quantity: 10, unitCost: 5, receivedAt: new Date('2026-01-01') },
      { inventoryId: 'lot-2', quantity: 4, unitCost: 8, receivedAt: new Date('2026-02-01') },
    ];
    const lines = buildTransferLines(batches);
    expect(lines).toEqual([
      { sourceInventoryId: 'lot-1', quantity: 10, unitCost: 5, originalReceivedAt: new Date('2026-01-01') },
      { sourceInventoryId: 'lot-2', quantity: 4, unitCost: 8, originalReceivedAt: new Date('2026-02-01') },
    ]);
  });

  it('empty consumption -> empty lines', () => {
    expect(buildTransferLines([])).toEqual([]);
  });
});

describe('resolveQuantityReceived', () => {
  it('defaults to the shipped quantity when no override given', () => {
    expect(resolveQuantityReceived(20)).toBe(20);
  });

  it('uses the override for a partial receipt', () => {
    expect(resolveQuantityReceived(20, 19)).toBe(19);
  });
});

describe('discrepancy', () => {
  it('is zero for a full receipt', () => {
    expect(discrepancy(20, 20)).toBe(0);
  });

  it('is positive for a short receipt (sent 20, received 19)', () => {
    expect(discrepancy(20, 19)).toBe(1);
  });
});
