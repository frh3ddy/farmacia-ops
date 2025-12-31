// Report Phase Component
const ReportPhase = ({ reportData }) => {
  const exportToCSV = () => {
    if (!reportData.errors || reportData.errors.length === 0) return;
    const csv = [
      ['Product', 'Error Message', 'Recommendation'],
      ...reportData.errors.map(err => [
        err.productName || err.productId || '',
        err.message || '',
        err.recommendation || ''
      ])
    ].map(row => row.map(cell => `"${cell}"`).join(',')).join('\\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'migration-errors.csv';
    a.click();
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="bg-green-50 border border-green-200 rounded-lg p-6">
        <h2 className="text-2xl font-bold text-green-800 mb-2">Migration Complete</h2>
        <div className="grid grid-cols-3 gap-4 mt-4">
          <div>
            <div className="text-2xl font-bold text-green-700">{reportData.productsProcessed || 0}</div>
            <div className="text-sm text-green-600">Items Migrated</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-red-700">{reportData.errors?.length || 0}</div>
            <div className="text-sm text-red-600">Errors</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-yellow-700">{reportData.skippedItems || 0}</div>
            <div className="text-sm text-yellow-600">Skipped</div>
          </div>
        </div>
      </div>

      {reportData.errors && reportData.errors.length > 0 && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold">Error List</h3>
            <button
              onClick={exportToCSV}
              className="px-4 py-2 bg-gray-600 text-white rounded-md text-sm"
            >
              Download Error Report CSV
            </button>
          </div>
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Error Message</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Recommendation</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {reportData.errors.map((err, idx) => (
                <tr key={idx}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {err.productName || err.productId || '—'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">{err.message || '—'}</td>
                  <td className="px-6 py-4 text-sm text-gray-600">{err.recommendation || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

