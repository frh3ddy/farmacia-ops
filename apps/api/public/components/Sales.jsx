// Sales Component
const { useState, useEffect } = React;

const Sales = () => {
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(new Set());

  useEffect(() => {
    const fetchFn = window.authFetch || fetch;
    fetchFn('/api/sales')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setSales(data.data || []);
        } else {
          setError(data.message || 'Failed to fetch sales');
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const toggleExpand = (id) => {
    const newExpanded = new Set(expanded);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpanded(newExpanded);
  };

  if (loading) return <div className="loading">Loading sales...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div>
      <h2>Sales ({sales.length})</h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Square ID</th>
            <th>Location</th>
            <th>Revenue</th>
            <th>Cost</th>
            <th>Profit</th>
            <th>Items</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((sale) => (
            <React.Fragment key={sale.id}>
              <tr className="expandable" onClick={() => toggleExpand(sale.id)}>
                <td>{expanded.has(sale.id) ? '▼' : '▶'}</td>
                <td><code>{sale.squareId}</code></td>
                <td>{sale.location?.name || sale.locationId}</td>
                <td>${parseFloat(sale.totalRevenue).toFixed(2)}</td>
                <td>${parseFloat(sale.totalCost).toFixed(2)}</td>
                <td>${parseFloat(sale.grossProfit).toFixed(2)}</td>
                <td>{sale.items?.length || 0}</td>
                <td>{new Date(sale.createdAt).toLocaleString()}</td>
              </tr>
              {expanded.has(sale.id) && (
                <tr>
                  <td colSpan="8">
                    <div className="details">
                      <h4>Sale Items:</h4>
                      <table>
                        <thead>
                          <tr>
                            <th>Product</th>
                            <th>Quantity</th>
                            <th>Price</th>
                            <th>Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sale.items?.map((item) => (
                            <tr key={item.id}>
                              <td>{item.product?.name || 'N/A'}</td>
                              <td>{item.quantity}</td>
                              <td>${parseFloat(item.price).toFixed(2)}</td>
                              <td>${parseFloat(item.cost).toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
};

