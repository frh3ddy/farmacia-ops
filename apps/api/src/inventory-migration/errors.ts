/**
 * Custom error classes for inventory migration
 */

export class MigrationError extends Error {
  constructor(
    public readonly errorType:
      | 'UNMAPPED_PRODUCT'
      | 'MISSING_COST'
      | 'INVALID_QUANTITY'
      | 'DATABASE_ERROR'
      | 'SQUARE_API_ERROR'
      | 'VALIDATION_ERROR'
      | 'MIGRATION_BLOCKED',
    message: string,
    public readonly canProceed: boolean = false,
    public readonly productId?: string,
    public readonly locationId?: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export class CutoverValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: string[],
  ) {
    super(`Cutover validation error: ${message}`);
    this.name = 'CutoverValidationError';
  }
}

export class UnmappedProductError extends Error {
  constructor(
    public readonly squareVariationId: string,
    public readonly locationId: string,
    message: string = 'Square variation is not mapped to a product. Please run catalog sync.',
  ) {
    super(
      `Unmapped product error: ${message}. ` +
        `Square variation ID: ${squareVariationId}, Location ID: ${locationId}`,
    );
    this.name = 'UnmappedProductError';
  }
}

export class MissingCostError extends Error {
  constructor(
    public readonly productId: string,
    public readonly productName: string,
    message: string = 'Cannot determine cost for product. Manual input required.',
  ) {
    super(`Missing cost error: ${message}. Product: ${productName} (${productId})`);
    this.name = 'MissingCostError';
  }
}

export class SquareApiError extends Error {
  constructor(
    message: string,
    public readonly originalError?: unknown,
    public readonly endpoint?: string,
  ) {
    super(`Square API error: ${message}`);
    this.name = 'SquareApiError';
  }
}



