// Review Phase Component
const ReviewPhase = ({ groupedResults, onStartMigration, loading }) => {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Review Extracted Costs</h2>
      
      <div className="bg-gray-50 rounded-lg p-6">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <div className="text-2xl font-bold text-gray-900">{groupedResults.approved.length}</div>
            <div className="text-sm text-gray-600">Approved</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-yellow-700">{groupedResults.extracting.length}</div>
            <div className="text-sm text-gray-600">Pending</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-red-700">{groupedResults.discarded.length}</div>
            <div className="text-sm text-gray-600">Discarded</div>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={onStartMigration}
          disabled={loading}
          className="px-6 py-2 bg-green-600 text-white rounded-md font-medium disabled:opacity-50"
        >
          {loading ? 'Starting Migration...' : 'Start Migration'}
        </button>
      </div>
    </div>
  );
};

