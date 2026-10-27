import { booksMismatches, type Books } from './books-check';

// Centro holds one product, "jarabe". Each test starts from books that add up
// and breaks one record.
function balancedBooks(): Books {
  return {
    batches: [
      // received 10, sold 4
      { id: 'b-recv', productId: 'jarabe', locationId: 'centro', quantity: 6, createdQuantity: 10 },
      // adjustment (e.g. a transfer receipt) added 5, 2 written off
      { id: 'b-adj', productId: 'jarabe', locationId: 'centro', quantity: 3, createdQuantity: 5 },
      // cutover opening stock: no movement created it
      { id: 'b-open', productId: 'jarabe', locationId: 'centro', quantity: 7, createdQuantity: null },
    ],
    negativeAdjustments: [{ id: 'adj-damage', productId: 'jarabe', locationId: 'centro', quantity: -2 }],
    saleItems: [{ id: 'si-1', productId: 'jarabe', locationId: 'centro', quantity: 4 }],
    consumedByBatch: { 'b-recv': 4, 'b-adj': 2 },
    consumedByAdjustment: { 'adj-damage': 2 },
    consumedBySaleItem: { 'si-1': 4 },
  };
}

describe('booksMismatches', () => {
  it('given books that add up, reports nothing', () => {
    expect(booksMismatches(balancedBooks())).toEqual([]);
  });

  it('given a batch whose stock changed without a recorded movement, reports the batch', () => {
    const books = balancedBooks();
    books.batches[0].quantity = 5; // created 10 − consumed 4 should leave 6

    expect(booksMismatches(books)).toEqual([
      { check: 'batch', recordId: 'b-recv', productId: 'jarabe', locationId: 'centro', expected: 6, actual: 5 },
    ]);
  });

  it('given a negative adjustment that took a different amount of stock, reports the adjustment', () => {
    const books = balancedBooks();
    books.consumedByAdjustment['adj-damage'] = 1;

    expect(booksMismatches(books)).toEqual([
      { check: 'adjustment', recordId: 'adj-damage', productId: 'jarabe', locationId: 'centro', expected: 2, actual: 1 },
    ]);
  });

  it('given a sale item whose consumption differs from the quantity sold, reports the sale item', () => {
    const books = balancedBooks();
    delete books.consumedBySaleItem['si-1']; // sold 4, nothing consumed (not costed)

    expect(booksMismatches(books)).toEqual([
      { check: 'saleItem', recordId: 'si-1', productId: 'jarabe', locationId: 'centro', expected: 4, actual: 0 },
    ]);
  });

  it('given opening stock that went negative, reports the batch', () => {
    const books = balancedBooks();
    books.batches[2].quantity = -1;

    expect(booksMismatches(books)).toEqual([
      { check: 'openingBatch', recordId: 'b-open', productId: 'jarabe', locationId: 'centro', expected: 0, actual: -1 },
    ]);
  });

  it('given opening stock that was sold from, does not report it (its start is unknown)', () => {
    const books = balancedBooks();
    books.consumedByBatch['b-open'] = 3;

    expect(booksMismatches(books)).toEqual([]);
  });
});
