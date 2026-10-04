import type { CutoverError, StructuredError } from "./types";

/**
 * One canonical error formatter. The legacy wizard had this exact logic
 * copy-pasted three times (apiHelpers.jsx, the never-wired-in
 * ErrorDisplay.jsx, and inline in ConfigurationPhase.jsx) — consolidated
 * here and actually used everywhere via <ErrorBanner>.
 */
const ERROR_TITLES: Record<string, string> = {
  SESSION_NOT_FOUND: "Sesión no encontrada",
  SESSION_EXPIRED: "Sesión expirada",
  SESSION_INVALID_STATE: "Estado de sesión no válido",
  LOCATION_NOT_FOUND: "Sucursal no encontrada",
  LOCATION_NO_SQUARE_ID: "Square no conectado",
  SQUARE_INVENTORY_FETCH_FAILED: "Error de conexión con Square",
  SQUARE_CATALOG_FETCH_FAILED: "Error del catálogo de Square",
  PRODUCT_MAPPING_FAILED: "Error al vincular productos",
  BATCH_PROCESSING_FAILED: "Falló el procesamiento del bloque",
  COST_EXTRACTION_FAILED: "Falló la extracción de costos",
  DATABASE_ERROR: "Error de base de datos",
  VALIDATION_ERROR: "Error de validación",
  PARTIAL_SUCCESS: "Éxito parcial",
  NETWORK_ERROR: "Error de conexión",
  UNKNOWN_ERROR: "Error",
};

export type FormattedError = {
  title: string;
  message: string;
  recoveryAction: string | null;
  canRetry: boolean;
  canResume: boolean;
  code: string | null;
};

export function formatCutoverError(error: CutoverError | null | undefined): FormattedError | null {
  if (!error) return null;

  if (typeof error === "string") {
    return { title: "Error", message: error, recoveryAction: null, canRetry: true, canResume: false, code: null };
  }

  return {
    title: ERROR_TITLES[error.code] ?? "Error",
    message: error.userMessage || error.message,
    recoveryAction: error.recoveryAction ?? null,
    canRetry: error.canRetry !== false,
    canResume: error.canResume === true,
    code: error.code,
  };
}

export function networkError(err: unknown, canResume: boolean): StructuredError {
  return {
    code: "NETWORK_ERROR",
    message: err instanceof Error ? err.message : String(err),
    userMessage: "No se pudo conectar con el servidor.",
    recoveryAction: "Revisa tu conexión a internet e inténtalo de nuevo.",
    canRetry: true,
    canResume,
  };
}
