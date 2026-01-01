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
  onStartExtraction,
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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Inventory Migration - Configuration</h2>
      
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
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

