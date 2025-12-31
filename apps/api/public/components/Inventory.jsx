// Inventory Component
const { useState, useEffect } = React;

const Inventory = () => {
  const [inventory, setInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState(null);

  const fetchInventory = () => {
    setLoading(true);
    setError(null);
    fetch('/api/inventory')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setInventory(data.data || []);
        } else {
          setError('Failed to fetch inventory');
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchInventory();
  }, []);

  const handleCreateTestInventory = async () => {
    setCreating(true);
    setError(null);
    setCreateResult(null);

    try {
      const response = await fetch('/api/inventory/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          squareVariationIds: ['YWASJW42SCO2V6MSXMTI55H5'],
        }),
      });

      const data = await response.json();
      if (data.success) {
        setCreateResult(data);
        fetchInventory();
      } else {
        setError(data.message || 'Failed to create test inventory');
      }
    } catch (err) {
      setError(err.message || 'Failed to create test inventory');
    } finally {
      setCreating(false);
    }
  };

  if (loading) return <div className="loading">Loading inventory...</div>;
  if (error) return <div className="error">{error}</div>;

  const grouped = inventory.reduce((acc, item) => {
    const key = `${item.productId}-${item.locationId}`;
    if (!acc[key]) {
      acc[key] = {
        product: item.product,
        location: item.location,
        items: [],
        totalQuantity: 0,
      };
    }
    acc[key].items.push(item);
    acc[key].totalQuantity += item.quantity;
    return acc;
  }, {});

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
        <h2>Inventory ({inventory.length} batches)</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button 
            onClick={handleCreateTestInventory} 
            disabled={creating}
            style={{ background: '#28a745' }}
          >
            {creating ? 'Creating...' : 'Pull Test Inventory'}
          </button>
          <button onClick={fetchInventory} className="btn-secondary">Refresh</button>
        </div>
      </div>
      
      {error && <div className="error">{error}</div>}
      {createResult && (
        <div className="success">
          <strong>Success!</strong> {createResult.message}
          <br />
          Created {createResult.count} inventory batch(es)
        </div>
      )}
      
      <div style={{ marginBottom: '20px', padding: '15px', background: '#f8f9fa', borderRadius: '4px' }}>
        <strong>Note:</strong> This is for testing purposes. A full inventory management feature will be added later.
        <br />
        <strong>Total Unique Products:</strong> {Object.keys(grouped).length}
        <br />
        <strong>Pull Test Inventory:</strong> Creates test inventory batches (100 units @ $5.00 each) for the specified Square variation ID and other products.
      </div>

      <h3>By Product & Location</h3>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Location</th>
            <th>Total Qty</th>
            <th>Batches</th>
          </tr>
        </thead>
        <tbody>
          {Object.values(grouped).map((group, idx) => (
            <tr key={idx}>
              <td>{group.product?.name || 'N/A'}</td>
              <td>{group.location?.name || group.location?.squareId || 'N/A'}</td>
              <td><strong>{group.totalQuantity}</strong></td>
              <td>{group.items.length}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: '30px' }}>All Inventory Batches (FIFO Order)</h3>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Location</th>
            <th>Quantity</th>
            <th>Unit Cost</th>
            <th>Total Cost</th>
            <th>Received At</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {inventory.map((item) => (
            <tr key={item.id}>
              <td>{item.product?.name || 'N/A'}</td>
              <td>{item.location?.name || item.location?.squareId || 'N/A'}</td>
              <td><strong>{item.quantity}</strong></td>
              <td>${parseFloat(item.unitCost).toFixed(2)}</td>
              <td>${(parseFloat(item.unitCost) * item.quantity).toFixed(2)}</td>
              <td>{new Date(item.receivedAt).toLocaleDateString()}</td>
              <td>{new Date(item.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {inventory.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: '#666' }}>
          No inventory records found. Create inventory batches to track stock.
        </div>
      )}
    </div>
  );
};

