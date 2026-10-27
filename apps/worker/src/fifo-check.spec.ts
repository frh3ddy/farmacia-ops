import { fifoViolations, type FifoCheckInput } from './fifo-check';

const saleAt = new Date('2026-10-26T18:00:00Z');

// A sale of jarabe at Centro that took stock from the October lot.
function input(overrides: Partial<FifoCheckInput> = {}): FifoCheckInput {
  return {
    saleItems: [{ id: 'si-1', productId: 'jarabe', locationId: 'centro', consumedAt: saleAt, consumedBatchIds: ['lot-oct'] }],
    batches: [
      { id: 'lot-oct', productId: 'jarabe', locationId: 'centro', quantity: 3, receivedAt: new Date('2026-10-01'), createdAt: new Date('2026-10-01') },
      { id: 'lot-nov', productId: 'jarabe', locationId: 'centro', quantity: 10, receivedAt: new Date('2026-10-20'), createdAt: new Date('2026-10-20') },
    ],
    ...overrides,
  };
}

describe('fifoViolations', () => {
  it('given a sale that took the oldest lot with stock, reports nothing', () => {
    expect(fifoViolations(input())).toEqual([]);
  });

  it('given a sale that took a newer lot while an older one still has stock, reports both lots', () => {
    const result = fifoViolations(
      input({ saleItems: [{ id: 'si-1', productId: 'jarabe', locationId: 'centro', consumedAt: saleAt, consumedBatchIds: ['lot-nov'] }] }),
    );

    expect(result).toEqual([
      { saleItemId: 'si-1', productId: 'jarabe', locationId: 'centro', consumedBatchId: 'lot-nov', skippedBatchId: 'lot-oct' },
    ]);
  });

  it('given an older lot that is empty, reports nothing', () => {
    const books = input({ saleItems: [{ id: 'si-1', productId: 'jarabe', locationId: 'centro', consumedAt: saleAt, consumedBatchIds: ['lot-nov'] }] });
    books.batches[0].quantity = 0;

    expect(fifoViolations(books)).toEqual([]);
  });

  it('given an older lot created after the sale (cutover or transfer with an old receivedAt), reports nothing', () => {
    const books = input({ saleItems: [{ id: 'si-1', productId: 'jarabe', locationId: 'centro', consumedAt: saleAt, consumedBatchIds: ['lot-nov'] }] });
    books.batches[0].createdAt = new Date('2026-10-27');

    expect(fifoViolations(books)).toEqual([]);
  });

  it('given an older lot of another product or location, reports nothing', () => {
    const books = input({ saleItems: [{ id: 'si-1', productId: 'jarabe', locationId: 'centro', consumedAt: saleAt, consumedBatchIds: ['lot-nov'] }] });
    books.batches[0].locationId = 'norte';

    expect(fifoViolations(books)).toEqual([]);
  });
});
