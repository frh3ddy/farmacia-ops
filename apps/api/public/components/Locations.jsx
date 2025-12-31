// Locations Component
const { useState, useEffect } = React;

const Locations = () => {
  const [locations, setLocations] = useState([]);
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [error, setError] = useState(null);

  const fetchLocations = async () => {
    setLoadingLocations(true);
    setError(null);
    try {
      const response = await fetch('/locations');
      const data = await response.json();
      if (data.success) {
        setLocations(data.data || []);
      } else {
        setError(data.message || 'Failed to fetch locations');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch locations');
      console.error('Failed to fetch locations:', err);
    } finally {
      setLoadingLocations(false);
    }
  };

  const syncLocationsFromSquare = async () => {
    setLoadingLocations(true);
    setError(null);
    try {
      const response = await fetch('/locations/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await response.json();
      if (data.success) {
        await fetchLocations();
        alert(`Successfully synced locations: ${data.result.created} created, ${data.result.updated} updated`);
      } else {
        setError(data.message || 'Failed to sync locations from Square');
      }
    } catch (err) {
      setError(err.message || 'Failed to sync locations from Square');
      console.error('Failed to sync locations:', err);
    } finally {
      setLoadingLocations(false);
    }
  };

  useEffect(() => {
    fetchLocations();
  }, []);

  if (loadingLocations && locations.length === 0) return <div className="loading">Loading locations...</div>;
  if (error && locations.length === 0) return <div className="error">{error}</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
        <h2>Locations ({locations.length})</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button 
            onClick={syncLocationsFromSquare} 
            disabled={loadingLocations}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loadingLocations ? 'Syncing...' : 'Sync from Square'}
          </button>
          <button 
            onClick={fetchLocations} 
            disabled={loadingLocations}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm font-medium rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loadingLocations ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Address</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {locations.map((location) => (
            <tr key={location.id}>
              <td><code>{location.id.substring(0, 8)}...</code></td>
              <td>{location.name}</td>
              <td>{location.address || '-'}</td>
              <td>
                <span className={`badge ${location.isActive ? 'badge-success' : 'badge-danger'}`}>
                  {location.isActive ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td>{new Date(location.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

