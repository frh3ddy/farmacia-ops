// Configuration Phase Component
const ConfigurationPhase = ({
  selectedLocationId,
  setSelectedLocationId,
  cutoverDate,
  setCutoverDate,
  costBasis,
  setCostBasis,
  batchSize,
  setBatchSize,
  locations,
  loading,
  error,
  setError,
  onStartExtraction,
  onRetry,
  showSessionSelector,
  existingSessions,
  onResumeSession,
  onStartNew,
  onCloseSessionSelector,
}) => {
  // Local state for batch size input to allow empty values during typing
  const [batchSizeInput, setBatchSizeInput] = React.useState(
    batchSize != null ? batchSize.toString() : '50'
  );
  
  // Sync local state when batchSize prop changes (e.g., when resuming session)
  React.useEffect(() => {
    if (batchSize != null) {
      setBatchSizeInput(batchSize.toString());
    }
  }, [batchSize]);

  const handleBatchSizeChange = (e) => {
    const value = e.target.value;
    setBatchSizeInput(value); // Allow empty string
    
    // Only update the actual batchSize if it's a valid number
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue > 0) {
      setBatchSize(numValue);
    }
  };

  const handleBatchSizeBlur = (e) => {
    const value = e.target.value.trim();
    const numValue = parseInt(value, 10);
    
    // If empty or invalid, set to default
    if (!value || isNaN(numValue) || numValue < 10) {
      setBatchSize(50);
      setBatchSizeInput('50');
    } else if (numValue > 500) {
      setBatchSize(500);
      setBatchSizeInput('500');
    } else {
      setBatchSize(numValue);
      setBatchSizeInput(numValue.toString());
    }
  };

  // Helper to parse error for display
  const parseError = (err) => {
    if (!err) return null;
    if (typeof err === 'string') return err;
    if (err.userMessage) return err.userMessage;
    if (err.message) return err.message;
    return 'An error occurred';
  };

  const getRecoveryAction = (err) => {
    if (!err || typeof err === 'string') return null;
    return err.recoveryAction || null;
  };

  const canRetry = (err) => {
    if (!err) return false;
    if (typeof err === 'string') return true;
    return err.canRetry !== false;
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Inventory Migration - Configuration</h2>
      
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-start">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3 flex-1">
              <p className="text-sm text-red-700">{parseError(error)}</p>
              {getRecoveryAction(error) && (
                <p className="mt-1 text-xs text-red-600 italic">
                  💡 {getRecoveryAction(error)}
                </p>
              )}
              {error?.code && error.code !== 'UNKNOWN_ERROR' && (
                <p className="mt-1 text-xs text-red-400">
                  Code: {error.code}
                </p>
              )}
            </div>
            <div className="ml-4 flex-shrink-0 flex">
              {canRetry(error) && onRetry && (
                <button
                  onClick={onRetry}
                  className="mr-2 text-sm text-red-600 hover:text-red-800 font-medium"
                >
                  Retry
                </button>
              )}
              {setError && (
                <button
                  onClick={() => setError(null)}
                  className="text-red-400 hover:text-red-600"
                >
                  <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6">
        {/* Location Selector */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Location <span className="text-red-500">*</span>
          </label>
          <div className="space-y-2">
            {locations.map(loc => (
              <label key={loc.id} className="flex items-center p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                <input
                  type="radio"
                  name="location"
                  value={loc.id}
                  checked={selectedLocationId === loc.id}
                  onChange={(e) => setSelectedLocationId(e.target.value)}
                  className="text-primary focus:ring-primary"
                />
                <span className="ml-3 text-sm text-gray-700">{loc.name}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Date Picker */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Cutover Date <span className="text-red-500">*</span>
          </label>
          <input
            type="date"
            value={cutoverDate}
            max={new Date().toISOString().split('T')[0]}
            onChange={(e) => setCutoverDate(e.target.value)}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary focus:ring-primary"
          />
        </div>

        {/* Method Selector */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Cost Method <span className="text-red-500">*</span>
          </label>
          <select
            value={costBasis}
            onChange={(e) => setCostBasis(e.target.value)}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary focus:ring-primary"
          >
            <option value="DESCRIPTION">Description Extraction</option>
            <option value="SQUARE_COST">Square Cost</option>
            <option value="MANUAL_INPUT">Manual Input</option>
            <option value="AVERAGE_COST">Average Cost</option>
          </select>
        </div>

        {/* Batch Size Input */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Batch Quantity
          </label>
          <input
            type="number"
            min="10"
            max="500"
            value={batchSizeInput}
            onChange={handleBatchSizeChange}
            onBlur={handleBatchSizeBlur}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary focus:ring-primary"
          />
          <p className="mt-1 text-xs text-gray-500">Between 10 and 500 items per batch</p>
        </div>

        <button
          onClick={onStartExtraction}
          disabled={loading || !selectedLocationId}
          className="w-full px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-md font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Starting...' : 'Start Extraction Session'}
        </button>
      </div>

      {/* Session Selector Modal */}
      {showSessionSelector && (
        <SessionSelector
          show={showSessionSelector}
          existingSessions={existingSessions}
          currentBatchSize={batchSize}
          onResume={onResumeSession}
          onStartNew={onStartNew}
          onClose={onCloseSessionSelector}
        />
      )}
    </div>
  );
};

