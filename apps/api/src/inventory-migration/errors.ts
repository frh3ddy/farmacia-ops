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
    super(`Error de validación del corte: ${message}`);
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

/**
 * Extraction-specific error types with recovery guidance
 */
export type ExtractionErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_INVALID_STATE'
  | 'LOCATION_NOT_FOUND'
  | 'LOCATION_NO_SQUARE_ID'
  | 'SQUARE_INVENTORY_FETCH_FAILED'
  | 'SQUARE_CATALOG_FETCH_FAILED'
  | 'PRODUCT_MAPPING_FAILED'
  | 'BATCH_PROCESSING_FAILED'
  | 'COST_EXTRACTION_FAILED'
  | 'DATABASE_ERROR'
  | 'VALIDATION_ERROR'
  | 'PARTIAL_SUCCESS';

export interface ExtractionErrorDetail {
  code: ExtractionErrorCode;
  message: string;
  userMessage: string;
  recoveryAction: string;
  canRetry: boolean;
  canResume: boolean;
  productId?: string;
  locationId?: string;
  batchNumber?: number;
  details?: Record<string, unknown>;
}

export class ExtractionError extends Error {
  public readonly code: ExtractionErrorCode;
  public readonly userMessage: string;
  public readonly recoveryAction: string;
  public readonly canRetry: boolean;
  public readonly canResume: boolean;
  public readonly productId?: string;
  public readonly locationId?: string;
  public readonly batchNumber?: number;
  public readonly details?: Record<string, unknown>;

  constructor(detail: ExtractionErrorDetail) {
    super(detail.message);
    this.name = 'ExtractionError';
    this.code = detail.code;
    this.userMessage = detail.userMessage;
    this.recoveryAction = detail.recoveryAction;
    this.canRetry = detail.canRetry;
    this.canResume = detail.canResume;
    this.productId = detail.productId;
    this.locationId = detail.locationId;
    this.batchNumber = detail.batchNumber;
    this.details = detail.details;
  }

  toJSON(): ExtractionErrorDetail {
    return {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      recoveryAction: this.recoveryAction,
      canRetry: this.canRetry,
      canResume: this.canResume,
      productId: this.productId,
      locationId: this.locationId,
      batchNumber: this.batchNumber,
      details: this.details,
    };
  }

  static sessionNotFound(sessionId: string): ExtractionError {
    return new ExtractionError({
      code: 'SESSION_NOT_FOUND',
      message: `Extraction session ${sessionId} not found`,
      userMessage: 'No se encontró la sesión de extracción. Es posible que se haya eliminado o expirado.',
      recoveryAction: 'Inicia una nueva sesión de extracción',
      canRetry: false,
      canResume: false,
      details: { sessionId },
    });
  }

  static sessionExpired(sessionId: string, lastUpdated: Date): ExtractionError {
    return new ExtractionError({
      code: 'SESSION_EXPIRED',
      message: `Extraction session ${sessionId} has expired (last updated: ${lastUpdated.toISOString()})`,
      userMessage: 'Esta sesión de extracción expiró. Inicia una nueva sesión.',
      recoveryAction: 'Inicia una nueva sesión de extracción',
      canRetry: false,
      canResume: false,
      details: { sessionId, lastUpdated: lastUpdated.toISOString() },
    });
  }

  static sessionInvalidState(sessionId: string, currentStatus: string, expectedStatus: string): ExtractionError {
    return new ExtractionError({
      code: 'SESSION_INVALID_STATE',
      message: `Session ${sessionId} is in ${currentStatus} state, expected ${expectedStatus}`,
      userMessage: `Esta sesión no se puede continuar. Estado actual: ${currentStatus}.`,
      recoveryAction: currentStatus === 'COMPLETED' 
        ? 'Esta sesión ya terminó. Inicia una nueva sesión para hacer más extracciones.'
        : 'Reinicia la sesión o inicia una nueva.',
      canRetry: false,
      canResume: currentStatus === 'FAILED',
      details: { sessionId, currentStatus, expectedStatus },
    });
  }

  static locationNotFound(locationId: string): ExtractionError {
    return new ExtractionError({
      code: 'LOCATION_NOT_FOUND',
      message: `Location ${locationId} not found in database`,
      userMessage: 'No se encontró la sucursal seleccionada.',
      recoveryAction: 'Recarga la página y selecciona una sucursal válida',
      canRetry: true,
      canResume: false,
      locationId,
    });
  }

  static locationNoSquareId(locationId: string, locationName: string): ExtractionError {
    return new ExtractionError({
      code: 'LOCATION_NO_SQUARE_ID',
      message: `Location ${locationName} (${locationId}) does not have a Square ID configured`,
      userMessage: `La sucursal "${locationName}" no está conectada a Square.`,
      recoveryAction: 'Conecta esta sucursal a Square en la configuración de administración',
      canRetry: false,
      canResume: false,
      locationId,
      details: { locationName },
    });
  }

  static squareInventoryFetchFailed(locationId: string, error: unknown): ExtractionError {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new ExtractionError({
      code: 'SQUARE_INVENTORY_FETCH_FAILED',
      message: `Failed to fetch Square inventory for location ${locationId}: ${errorMessage}`,
      userMessage: 'No se pudo obtener el inventario de Square. Puede ser un problema temporal.',
      recoveryAction: 'Espera un momento e inténtalo de nuevo. Si el problema continúa, revisa el estado de la API de Square.',
      canRetry: true,
      canResume: true,
      locationId,
      details: { originalError: errorMessage },
    });
  }

  static squareCatalogFetchFailed(variationIds: string[], error: unknown): ExtractionError {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new ExtractionError({
      code: 'SQUARE_CATALOG_FETCH_FAILED',
      message: `Failed to fetch Square catalog data for ${variationIds.length} variations: ${errorMessage}`,
      userMessage: 'No se pudieron obtener los detalles de los productos de Square. Algunos productos pueden mostrar información incompleta.',
      recoveryAction: 'Reintenta la extracción. Los nombres pueden estar incompletos, pero puedes continuar.',
      canRetry: true,
      canResume: true,
      details: { variationCount: variationIds.length, originalError: errorMessage },
    });
  }

  static productMappingFailed(unmappedCount: number, totalCount: number): ExtractionError {
    return new ExtractionError({
      code: 'PRODUCT_MAPPING_FAILED',
      message: `${unmappedCount} of ${totalCount} products could not be mapped from Square catalog`,
      userMessage: `${unmappedCount} productos no están vinculados a Square y se omitirán.`,
      recoveryAction: 'Sincroniza el catálogo para vincular los productos faltantes y reintenta la extracción.',
      canRetry: true,
      canResume: true,
      details: { unmappedCount, totalCount, mappedCount: totalCount - unmappedCount },
    });
  }

  static batchProcessingFailed(batchNumber: number, totalBatches: number, error: unknown): ExtractionError {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new ExtractionError({
      code: 'BATCH_PROCESSING_FAILED',
      message: `Failed to process batch ${batchNumber}/${totalBatches}: ${errorMessage}`,
      userMessage: `No se pudo procesar el bloque ${batchNumber}. Tu avance quedó guardado.`,
      recoveryAction: 'Continúa la sesión para reintentar este bloque.',
      canRetry: true,
      canResume: true,
      batchNumber,
      details: { totalBatches, originalError: errorMessage },
    });
  }

  static partialSuccess(
    processedCount: number, 
    failedCount: number, 
    totalCount: number,
    failures: Array<{ productId: string; reason: string }>
  ): ExtractionError {
    return new ExtractionError({
      code: 'PARTIAL_SUCCESS',
      message: `Processed ${processedCount}/${totalCount} items, ${failedCount} failed`,
      userMessage: `La extracción terminó con ${failedCount} productos que requieren atención.`,
      recoveryAction: 'Revisa los productos con error y reinténtalos u omítelos manualmente.',
      canRetry: true,
      canResume: true,
      details: { processedCount, failedCount, totalCount, failures: failures.slice(0, 10) },
    });
  }

  static databaseError(operation: string, error: unknown): ExtractionError {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new ExtractionError({
      code: 'DATABASE_ERROR',
      message: `Database error during ${operation}: ${errorMessage}`,
      userMessage: 'Ocurrió un error de base de datos. Es posible que tus cambios recientes no se hayan guardado.',
      recoveryAction: 'Espera un momento e inténtalo de nuevo. Si el problema continúa, contacta a soporte.',
      canRetry: true,
      canResume: true,
      details: { operation, originalError: errorMessage },
    });
  }

  static validationError(field: string, value: unknown, constraint: string): ExtractionError {
    return new ExtractionError({
      code: 'VALIDATION_ERROR',
      message: `Validation failed for ${field}: ${constraint}`,
      userMessage: `Dato no válido: ${constraint}`,
      recoveryAction: 'Corrige el dato e inténtalo de nuevo.',
      canRetry: true,
      canResume: false,
      details: { field, value, constraint },
    });
  }
}

/**
 * Result type for extraction operations that may partially succeed
 */
export interface ExtractionOperationResult<T> {
  success: boolean;
  data?: T;
  error?: ExtractionErrorDetail;
  warnings?: Array<{
    code: string;
    message: string;
    productId?: string;
    locationId?: string;
  }>;
  partialResults?: {
    succeeded: number;
    failed: number;
    skipped: number;
  };
}
