// Migration Phase Component
const MigrationPhase = ({ migrationResult }) => {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Migration Execution</h2>
      
      <div className="bg-gray-50 rounded-lg p-6 text-center">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-primary mb-4"></div>
        <p className="text-gray-700 font-medium">Processing migration...</p>
        {migrationResult && (
          <div className="mt-4 text-sm text-gray-600">
            <p>Batch: {migrationResult.currentBatch} / {migrationResult.totalBatches}</p>
            <p>Processed: {migrationResult.processedItems} / {migrationResult.totalItems}</p>
            {migrationResult.skippedItems > 0 && (
              <p className="text-yellow-600">Skipped: {migrationResult.skippedItems} items</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

