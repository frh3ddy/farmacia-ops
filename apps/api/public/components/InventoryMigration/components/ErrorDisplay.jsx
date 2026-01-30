// ErrorDisplay Component - Shows structured errors with recovery options

const ErrorDisplay = ({ 
  error, 
  onRetry, 
  onResume,
  onDismiss,
  onStartNew,
  showRetry = true,
  showResume = false,
  showStartNew = false,
  className = '',
}) => {
  if (!error) return null;

  // Parse error - can be string or structured error object
  const parseError = (err) => {
    if (typeof err === 'string') {
      return {
        title: 'Error',
        message: err,
        recoveryAction: null,
        canRetry: true,
        canResume: false,
        code: null,
      };
    }
    
    if (err.userMessage || err.message) {
      return {
        title: getErrorTitle(err.code),
        message: err.userMessage || err.message,
        recoveryAction: err.recoveryAction || null,
        canRetry: err.canRetry !== false,
        canResume: err.canResume === true,
        code: err.code,
        details: err.details,
      };
    }
    
    return {
      title: 'Error',
      message: 'An unexpected error occurred.',
      recoveryAction: 'Please try again.',
      canRetry: true,
      canResume: false,
      code: null,
    };
  };

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
      'NETWORK_ERROR': 'Connection Error',
      'UNKNOWN_ERROR': 'Error',
    };
    
    return titles[code] || 'Error';
  };

  const getErrorIcon = (code) => {
    if (code === 'PARTIAL_SUCCESS') return '⚠️';
    if (code === 'NETWORK_ERROR' || code?.includes('SQUARE')) return '🔌';
    if (code?.includes('SESSION')) return '📋';
    if (code === 'VALIDATION_ERROR') return '⚡';
    return '❌';
  };

  const parsed = parseError(error);
  const isWarning = parsed.code === 'PARTIAL_SUCCESS';

  return (
    <div 
      className={`error-display ${isWarning ? 'warning' : 'error'} ${className}`}
      style={{
        padding: '16px',
        marginBottom: '16px',
        borderRadius: '8px',
        backgroundColor: isWarning ? '#fff8e1' : '#ffebee',
        border: `1px solid ${isWarning ? '#ffc107' : '#f44336'}`,
      }}
    >
      {/* Header */}
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        marginBottom: '8px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '20px' }}>{getErrorIcon(parsed.code)}</span>
          <strong style={{ 
            color: isWarning ? '#f57c00' : '#c62828',
            fontSize: '16px',
          }}>
            {parsed.title}
          </strong>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '18px',
              color: '#999',
              padding: '4px',
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>

      {/* Message */}
      <p style={{ 
        margin: '0 0 12px 0',
        color: '#333',
        lineHeight: '1.5',
      }}>
        {parsed.message}
      </p>

      {/* Recovery Action */}
      {parsed.recoveryAction && (
        <p style={{ 
          margin: '0 0 12px 0',
          color: '#666',
          fontSize: '14px',
          fontStyle: 'italic',
        }}>
          💡 {parsed.recoveryAction}
        </p>
      )}

      {/* Error Code (for debugging) */}
      {parsed.code && parsed.code !== 'UNKNOWN_ERROR' && (
        <p style={{ 
          margin: '0 0 12px 0',
          color: '#999',
          fontSize: '12px',
        }}>
          Error code: {parsed.code}
        </p>
      )}

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {showRetry && parsed.canRetry && onRetry && (
          <button
            onClick={onRetry}
            style={{
              padding: '8px 16px',
              backgroundColor: '#1976d2',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            🔄 Try Again
          </button>
        )}
        
        {showResume && parsed.canResume && onResume && (
          <button
            onClick={onResume}
            style={{
              padding: '8px 16px',
              backgroundColor: '#388e3c',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            ▶️ Resume Session
          </button>
        )}
        
        {showStartNew && onStartNew && (
          <button
            onClick={onStartNew}
            style={{
              padding: '8px 16px',
              backgroundColor: '#f57c00',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            🆕 Start New Session
          </button>
        )}
      </div>
    </div>
  );
};

// Export for use in other components
if (typeof window !== 'undefined') {
  window.ErrorDisplay = ErrorDisplay;
}
