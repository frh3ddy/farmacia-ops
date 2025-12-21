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

export class UnmappedVariationError extends Error {
  constructor(
    public readonly squareVariationId: string,
    public readonly locationId: string,
    public readonly message: string = 'Square variation is not mapped to a product. Please run catalog sync.',
  ) {
    super(
      `Unmapped variation error: ${message}. ` +
        `Square variation ID: ${squareVariationId}, Location ID: ${locationId}`,
    );
    this.name = 'UnmappedVariationError';
  }
}

export class ProductNotFoundError extends Error {
  constructor(
    public readonly productId: string,
    public readonly mappingId: string,
    public readonly message: string = 'Mapped product does not exist in database',
  ) {
    super(
      `Product not found error: ${message}. ` +
        `Product ID: ${productId}, Mapping ID: ${mappingId}`,
    );
    this.name = 'ProductNotFoundError';
  }
}

