/**
 * Custom error classes for sale worker
 */

export class InsufficientInventoryError extends Error {
  constructor(
    public readonly productId: string,
    public readonly locationId: string,
    public readonly requested: number,
    public readonly available: number,
    public readonly shortage: number,
  ) {
    super(
      `Insufficient inventory for product ${productId} at location ${locationId}. ` +
        `Requested: ${requested}, Available: ${available}, Shortage: ${shortage}`,
    );
    this.name = 'InsufficientInventoryError';
  }
}

export class DatabaseTransactionError extends Error {
  constructor(
    message: string,
    public readonly originalError?: unknown,
  ) {
    super(`Database transaction error: ${message}`);
    this.name = 'DatabaseTransactionError';
  }
}

export class SaleValidationError extends Error {
  constructor(message: string, public readonly context?: Record<string, unknown>) {
    super(`Sale validation error: ${message}`);
    this.name = 'SaleValidationError';
  }
}

