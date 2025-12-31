// Batch Complete Modal Component
const BatchCompleteModal = ({ 
  show, 
  loading, 
  onContinue, 
  onReview, 
  onPause 
}) => {
  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md">
        <h3 className="text-lg font-bold mb-4">Batch Complete</h3>
        <p className="text-sm text-gray-600 mb-4">
          All items in this batch have been reviewed. Choose an action:
        </p>
        <div className="flex flex-col gap-3">
          <button
            onClick={onContinue}
            disabled={loading}
            className="w-full px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-md font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Loading...' : 'Continue to Next Batch'}
          </button>
          <button
            onClick={onReview}
            disabled={loading}
            className="w-full px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Review & Start Migration
          </button>
          <button
            onClick={onPause}
            className="w-full px-4 py-2 border border-gray-300 hover:bg-gray-50 rounded-md"
          >
            Pause & Exit
          </button>
        </div>
      </div>
    </div>
  );
};

