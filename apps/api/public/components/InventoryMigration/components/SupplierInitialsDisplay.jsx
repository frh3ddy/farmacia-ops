// Supplier Initials Display Component
const SupplierInitialsDisplay = ({ 
  supplierInitialsMap, 
  onClear, 
  onRemove 
}) => {
  if (!supplierInitialsMap || Object.keys(supplierInitialsMap).length === 0) {
    return null;
  }

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-blue-900">
          Supplier Initials Learned ({Object.keys(supplierInitialsMap).length})
        </h4>
        <button
          onClick={onClear}
          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
        >
          Clear All
        </button>
      </div>
      <div className="space-y-2">
        {Object.entries(supplierInitialsMap).map(([supplierName, initials]) => (
          <div key={supplierName} className="flex items-center justify-between bg-white rounded p-2 border border-blue-100">
            <div className="flex-1">
              <span className="font-medium text-blue-900 text-sm">{supplierName}:</span>
              <span className="text-blue-700 ml-2 text-sm">
                {Array.isArray(initials) ? initials.join(', ') : initials}
              </span>
            </div>
            <button
              onClick={() => onRemove(supplierName)}
              className="text-xs text-red-600 hover:text-red-800 ml-2"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <p className="text-xs text-blue-600 mt-2">
        These will be saved when you approve items to help match suppliers in future extractions.
      </p>
    </div>
  );
};

