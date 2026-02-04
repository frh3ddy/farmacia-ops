// CatalogSync Component
const { useState } = React;

const CatalogSync = () => {
  const [locationId, setLocationId] = useState('');
  const [forceResync, setForceResync] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupResult, setCleanupResult] = useState(null);

  const handleCleanup = async () => {
    if (!confirm('This will delete all catalog mappings and ALL products. Are you sure? This cannot be undone!')) {
      return;
    }

    setCleaningUp(true);
    setError(null);
    setCleanupResult(null);

    try {
      const fetchFn = window.authFetch || fetch;
      const response = await fetchFn('/api/catalog/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteProducts: true }),
      });

      const data = await response.json();
      if (response.ok) {
        setCleanupResult(data);
        setResult(null);
      } else {
        setError(data.message || 'Cleanup failed');
      }
    } catch (err) {
      setError(err.message || 'Failed to cleanup catalog');
    } finally {
      setCleaningUp(false);
    }
  };

  const handleSync = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const fetchFn = window.authFetch || fetch;
      const response = await fetchFn('/admin/square/catalog/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId: locationId || null,
          forceResync,
        }),
      });

      const data = await response.json();
      if (response.ok) {
        setResult(data);
      } else {
        setError(data.message || 'Sync failed');
      }
    } catch (err) {
      setError(err.message || 'Failed to sync catalog');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>Catalog Sync</h2>
      <div style={{ marginBottom: '20px', padding: '15px', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: '4px' }}>
        <strong>⚠️ Cleanup Option:</strong> Use the cleanup button below to delete ALL related records (cost approvals, catalog mappings, supplier products, cost history, inventory, sale items, placements) and ALL products to start completely fresh. This will remove all products and their relationships from the database.
      </div>
      <div style={{ marginBottom: '20px' }}>
        <button 
          onClick={handleCleanup} 
          disabled={cleaningUp}
          style={{ 
            background: cleaningUp ? '#6c757d' : '#dc3545', 
            color: 'white',
            padding: '10px 20px',
            border: 'none',
            borderRadius: '4px',
            cursor: cleaningUp ? 'not-allowed' : 'pointer',
            marginRight: '10px'
          }}
        >
          {cleaningUp ? 'Cleaning Up...' : '🧹 Cleanup Catalog (Delete Mappings & Clear Square Data)'}
        </button>
        {cleanupResult && (
          <div className="success" style={{ marginTop: '10px' }}>
            <strong>Cleanup Complete:</strong> Deleted {cleanupResult.data?.costApprovalsDeleted || 0} cost approvals, {cleanupResult.data?.mappingsDeleted || 0} mappings, {cleanupResult.data?.supplierProductsDeleted || 0} supplier products, {cleanupResult.data?.costHistoryDeleted || 0} cost history records, {cleanupResult.data?.inventoryDeleted || 0} inventory records, {cleanupResult.data?.saleItemsDeleted || 0} sale items, {cleanupResult.data?.placementsDeleted || 0} placements, {cleanupResult.data?.productsDeleted || 0} products deleted, {cleanupResult.data?.productsUpdated || 0} products updated
          </div>
        )}
      </div>
      <div className="form-group">
        <label>Location ID (optional):</label>
        <input
          type="text"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          placeholder="Leave empty for global sync"
        />
      </div>
      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={forceResync}
            onChange={(e) => setForceResync(e.target.checked)}
          />
          Force Resync (re-sync existing mappings)
        </label>
      </div>
      <button onClick={handleSync} disabled={loading}>
        {loading ? 'Syncing...' : 'Sync Catalog'}
      </button>

      {error && <div className="error">{error}</div>}
      {result && (
        <div className="success">
          <h3>Sync Results</h3>
          <p><strong>Total Variations Found:</strong> {result.result?.totalVariationsFound || 0}</p>
          <p><strong>Variations Processed:</strong> {result.result?.variationsProcessed || 0}</p>
          <p><strong>Products Created:</strong> {result.result?.productsCreated || 0}</p>
          <p><strong>Mappings Created:</strong> {result.result?.mappingsCreated || 0}</p>
          <p><strong>Mappings Skipped:</strong> {result.result?.mappingsSkipped || 0}</p>
          {result.result?.errors?.length > 0 && (
            <div>
              <strong>Errors:</strong>
              <ul>
                {result.result.errors.map((err, i) => (
                  <li key={i}>{err.variationName}: {err.error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

