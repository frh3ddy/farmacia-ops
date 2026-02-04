// API Helper Functions for Inventory Migration

// Use authFetch if available (from Auth.jsx), otherwise fall back to regular fetch
const apiFetch = (url, options) => {
  const fetchFn = window.authFetch || fetch;
  return fetchFn(url, options);
};

/**
 * Structured error object from API
 * @typedef {Object} ApiError
 * @property {string} code - Error code (e.g., 'SESSION_NOT_FOUND', 'VALIDATION_ERROR')
 * @property {string} message - Technical error message
 * @property {string} userMessage - User-friendly error message
 * @property {string} recoveryAction - Suggested action to resolve the error
 * @property {boolean} canRetry - Whether the operation can be retried
 * @property {boolean} canResume - Whether a session can be resumed
 */

/**
 * Parse API response and extract structured error if present
 */
const parseApiResponse = async (response) => {
  const data = await response.json();
  
  if (!response.ok || !data.success) {
    // Check for structured error
    if (data.error && typeof data.error === 'object') {
      return {
        success: false,
        error: data.error,
        message: data.error.userMessage || data.message || 'An error occurred',
      };
    }
    
    // Fallback to simple error
    return {
      success: false,
      error: {
        code: 'UNKNOWN_ERROR',
        message: data.message || 'An error occurred',
        userMessage: data.message || 'An unexpected error occurred.',
        recoveryAction: 'Please try again.',
        canRetry: true,
        canResume: false,
      },
      message: data.message || 'An error occurred',
    };
  }
  
  return { success: true, data };
};

/**
 * Format error for display
 */
const formatErrorForDisplay = (error) => {
  if (!error) return null;
  
  if (typeof error === 'string') {
    return {
      title: 'Error',
      message: error,
      recoveryAction: null,
      canRetry: true,
      canResume: false,
    };
  }
  
  if (error.userMessage || error.message) {
    return {
      title: getErrorTitle(error.code),
      message: error.userMessage || error.message,
      recoveryAction: error.recoveryAction || null,
      canRetry: error.canRetry !== false,
      canResume: error.canResume === true,
      code: error.code,
    };
  }
  
  return {
    title: 'Error',
    message: 'An unexpected error occurred.',
    recoveryAction: 'Please try again.',
    canRetry: true,
    canResume: false,
  };
};

/**
 * Get human-readable title for error codes
 */
const getErrorTitle = (code) => {
  const titles = {
    'SESSION_NOT_FOUND': 'Session Not Found',
    'SESSION_EXPIRED': 'Session Expired',
    'SESSION_INVALID_STATE': 'Invalid Session State',
    'LOCATION_NOT_FOUND': 'Location Not Found',
    'LOCATION_NO_SQUARE_ID': 'Square Not Connected',
    'SQUARE_INVENTORY_FETCH_FAILED': 'Square Connection Error',
    'SQUARE_CATALOG_FETCH_FAILED': 'Square Catalog Error',
    'PRODUCT_MAPPING_FAILED': 'Product Mapping Error',
    'BATCH_PROCESSING_FAILED': 'Batch Processing Failed',
    'COST_EXTRACTION_FAILED': 'Cost Extraction Failed',
    'DATABASE_ERROR': 'Database Error',
    'VALIDATION_ERROR': 'Validation Error',
    'PARTIAL_SUCCESS': 'Partial Success',
    'UNKNOWN_ERROR': 'Error',
  };
  
  return titles[code] || 'Error';
};

/**
 * Validate extraction session before resuming
 */
const validateSession = async (sessionId) => {
  try {
    const response = await fetch(`/admin/inventory/cutover/extraction-session/${sessionId}/validate`);
    return await parseApiResponse(response);
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: err.message,
        userMessage: 'Unable to validate session. Check your connection.',
        recoveryAction: 'Check your internet connection and try again.',
        canRetry: true,
        canResume: false,
      },
    };
  }
};

/**
 * Reset a failed extraction session
 */
const resetExtractionSession = async (sessionId) => {
  try {
    const response = await fetch(`/admin/inventory/cutover/extraction-session/${sessionId}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return await parseApiResponse(response);
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: err.message,
        userMessage: 'Unable to reset session. Check your connection.',
        recoveryAction: 'Check your internet connection and try again.',
        canRetry: true,
        canResume: false,
      },
    };
  }
};

/**
 * Get extraction health status
 */
const getExtractionHealth = async (locationId = null) => {
  try {
    const url = locationId 
      ? `/admin/inventory/cutover/extraction-health?locationId=${locationId}`
      : '/admin/inventory/cutover/extraction-health';
    const response = await fetch(url);
    return await parseApiResponse(response);
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: err.message,
        userMessage: 'Unable to fetch health status.',
        recoveryAction: 'Check your internet connection and try again.',
        canRetry: true,
        canResume: false,
      },
    };
  }
};

// Fetch locations
const fetchLocations = async (setLocations, setError) => {
  try {
    const response = await apiFetch('/locations');
    const data = await response.json();
    if (data.success) {
      setLocations(data.data || []);
    }
  } catch (err) {
    const formatted = formatErrorForDisplay(err);
    setError(formatted.message || 'Failed to fetch locations');
  }
};

// Fetch all suppliers
const fetchAllSuppliers = async (setAllSuppliers) => {
  try {
    const response = await apiFetch('/admin/inventory/cutover/suppliers');
    const data = await response.json();
    if (data.success) {
      const suppliers = data.suppliers || [];
      setAllSuppliers(suppliers);
      return suppliers;
    }
    return [];
  } catch (err) {
    console.error('Failed to fetch suppliers:', err);
    return [];
  }
};

// Fetch existing extraction sessions
const fetchExistingSessions = async (locationId, setExistingSessions) => {
  try {
    const url = locationId 
      ? `/admin/inventory/cutover/extraction-sessions?locationId=${locationId}`
      : '/admin/inventory/cutover/extraction-sessions';
    const response = await fetch(url);
    const data = await response.json();
    if (data.success) {
      // Filter to only IN_PROGRESS sessions
      const inProgressSessions = data.sessions.filter(s => s.status === 'IN_PROGRESS');
      setExistingSessions(inProgressSessions);
      return inProgressSessions;
    }
    return [];
  } catch (err) {
    console.error('Failed to fetch existing sessions:', err);
    return [];
  }
};

