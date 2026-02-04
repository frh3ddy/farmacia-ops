// CatalogMappings Component
const { useState, useEffect } = React;

const CatalogMappings = () => {
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchMappings = async () => {
    setLoading(true);
    setError(null);
    try {
      const fetchFn = window.authFetch || fetch;
      const response = await fetchFn('/api/catalog/mappings');
      const data = await response.json();
      if (data.success) {
        setMappings(data.data || []);
      } else {
        setError(data.message || 'Failed to fetch mappings');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch mappings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMappings();
  }, []);

  if (loading) return <div className="loading">Loading mappings...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Catalog Mappings ({mappings.length})</h2>
        <button onClick={fetchMappings} className="btn-secondary">Refresh</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Variation ID</th>
            <th>Product</th>
            <th>Location</th>
            <th>Synced At</th>
          </tr>
        </thead>
        <tbody>
          {mappings.map((mapping) => (
            <tr key={mapping.id}>
              <td><code>{mapping.squareVariationId}</code></td>
              <td>{mapping.product?.name || 'N/A'}</td>
              <td>{mapping.location?.name || (mapping.locationId ? mapping.locationId : 'Global')}</td>
              <td>{new Date(mapping.syncedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

