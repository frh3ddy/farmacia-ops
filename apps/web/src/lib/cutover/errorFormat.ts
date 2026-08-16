import type { CutoverError, StructuredError } from "./types";

/**
 * One canonical error formatter. The legacy wizard had this exact logic
 * copy-pasted three times (apiHelpers.jsx, the never-wired-in
 * ErrorDisplay.jsx, and inline in ConfigurationPhase.jsx) — consolidated
 * here and actually used everywhere via <ErrorBanner>.
 */
const ERROR_TITLES: Record<string, string> = {
  SESSION_NOT_FOUND: "Session Not Found",
  SESSION_EXPIRED: "Session Expired",
  SESSION_INVALID_STATE: "Invalid Session State",
  LOCATION_NOT_FOUND: "Location Not Found",
  LOCATION_NO_SQUARE_ID: "Square Not Connected",
  SQUARE_INVENTORY_FETCH_FAILED: "Square Connection Error",
  SQUARE_CATALOG_FETCH_FAILED: "Square Catalog Error",
  PRODUCT_MAPPING_FAILED: "Product Mapping Error",
  BATCH_PROCESSING_FAILED: "Batch Processing Failed",
  COST_EXTRACTION_FAILED: "Cost Extraction Failed",
  DATABASE_ERROR: "Database Error",
  VALIDATION_ERROR: "Validation Error",
  PARTIAL_SUCCESS: "Partial Success",
  NETWORK_ERROR: "Connection Error",
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
    userMessage: "Unable to connect to the server.",
    recoveryAction: "Check your internet connection and try again.",
    canRetry: true,
    canResume,
  };
}
