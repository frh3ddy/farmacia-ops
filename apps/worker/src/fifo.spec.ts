import { consumeBatchesFifo, type FifoBatch } from './fifo';

// Oldest-first: caller is responsible for the receivedAt-asc ordering, this
// module just walks whatever order it's given.
const oldLot: FifoBatch = { id: 'lot-old', quantity: 10, unitCost: 5 };
const newLot: FifoBatch = { id: 'lot-new', quantity: 10, unitCost: 8 };

describe('consumeBatchesFifo', () => {
  it('consumes 1 unit from the oldest lot only', () => {
    const result = consumeBatchesFifo([oldLot, newLot], 1);
    expect(result.consumedBatches).toEqual([
      { batchId: 'lot-old', quantityConsumed: 1, costContribution: expect.anything() },
    ]);
    expect(result.totalCost.toNumber()).toBe(5);
    expect(result.remainingQuantity).toBe(0);
  });

  it('a sale spanning two lots: cost is the weighted sum across both', () => {
    // 15 units requested, only 10 left in the oldest lot
    const result = consumeBatchesFifo([oldLot, newLot], 15);
    expect(result.consumedBatches.map((b) => b.batchId)).toEqual(['lot-old', 'lot-new']);
    expect(result.consumedBatches[0].quantityConsumed).toBe(10);
    expect(result.consumedBatches[1].quantityConsumed).toBe(5);
    // 10*5 + 5*8 = 90
    expect(result.totalCost.toNumber()).toBe(90);
    expect(result.remainingQuantity).toBe(0);
  });

  it('mixed sequence of sales leaves correct cumulative state across calls', () => {
    // Simulates 3 sequential sales against the same starting pool by
    // decrementing quantities exactly like deductInventory would.
    let lots: FifoBatch[] = [
      { id: 'lot-1', quantity: 20, unitCost: 5 },
      { id: 'lot-2', quantity: 20, unitCost: 8 },
    ];
    let cumulativeCost = 0;

    const sell = (qty: number) => {
      const result = consumeBatchesFifo(lots, qty);
      cumulativeCost += result.totalCost.toNumber();
      const consumed = new Map(result.consumedBatches.map((b) => [b.batchId, b.quantityConsumed]));
      lots = lots.map((l) => ({ ...l, quantity: l.quantity - (consumed.get(l.id) ?? 0) })).filter((l) => l.quantity > 0);
    };

    sell(20); // fully drains lot-1, cost 100
    sell(1); // from lot-2, cost 8
    sell(19); // remainder of lot-2, cost 19*8=152

    expect(cumulativeCost).toBe(100 + 8 + 152);
    expect(lots).toEqual([]);
  });

  it('reports remainingQuantity > 0 when batches run out (insufficient inventory)', () => {
    const result = consumeBatchesFifo([oldLot], 15);
    expect(result.consumedBatches[0].quantityConsumed).toBe(10);
    expect(result.remainingQuantity).toBe(5);
  });

  it('empty batch list -> zero cost, full remaining quantity, no consumed batches', () => {
    const result = consumeBatchesFifo([], 5);
    expect(result.consumedBatches).toEqual([]);
    expect(result.totalCost.toNumber()).toBe(0);
    expect(result.remainingQuantity).toBe(5);
  });
});
