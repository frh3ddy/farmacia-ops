// InventoryAging Component
const { useState, useEffect } = React;

const InventoryAging = () => {
  const [activeView, setActiveView] = useState('summary');
  const [summary, setSummary] = useState(null);
  const [products, setProducts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [categories, setCategories] = useState([]);
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // Filters
  const [locationId, setLocationId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [riskLevel, setRiskLevel] = useState('');
  const [severity, setSeverity] = useState('');
  const [signalType, setSignalType] = useState('');
  const [limit, setLimit] = useState('100');
  const [offset, setOffset] = useState('0');

  const fetchSummary = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (locationId && locationId.trim()) params.append('locationId', locationId.trim());
      if (categoryId && categoryId.trim()) params.append('categoryId', categoryId.trim());
      const response = await fetch(`/inventory/aging/summary?${params}`);
      const data = await response.json();
      if (response.ok) {
        setSummary(data);
      } else {
        setError(data.message || 'Failed to fetch summary');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch summary');
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (locationId && locationId.trim()) params.append('locationId', locationId.trim());
      if (categoryId && categoryId.trim()) params.append('categoryId', categoryId.trim());
      if (riskLevel && riskLevel.trim()) params.append('riskLevel', riskLevel.trim());
      if (limit && limit.trim()) params.append('limit', limit.trim());
      if (offset && offset.trim()) params.append('offset', offset.trim());
      const response = await fetch(`/inventory/aging/products?${params}`);
      const data = await response.json();
      if (response.ok) {
        setProducts(data.products || []);
      } else {
        setError(data.message || 'Failed to fetch products');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch products');
    } finally {
      setLoading(false);
    }
  };

  const fetchLocations = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (locationId && locationId.trim()) params.append('locationId', locationId.trim());
      const response = await fetch(`/inventory/aging/location?${params}`);
      const data = await response.json();
      if (response.ok) {
        setLocations(data.locations || []);
      } else {
        setError(data.message || 'Failed to fetch locations');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch locations');
    } finally {
      setLoading(false);
    }
  };

  const fetchCategories = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (categoryId && categoryId.trim()) params.append('categoryId', categoryId.trim());
      const response = await fetch(`/inventory/aging/category?${params}`);
      const data = await response.json();
      if (response.ok) {
        setCategories(data.categories || []);
      } else {
        setError(data.message || 'Failed to fetch categories');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch categories');
    } finally {
      setLoading(false);
    }
  };

  const fetchSignals = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (severity && severity.trim()) params.append('severity', severity.trim());
      if (signalType && signalType.trim()) params.append('type', signalType.trim());
      if (limit && limit.trim()) params.append('limit', limit.trim());
      const response = await fetch(`/inventory/aging/signals?${params}`);
      const data = await response.json();
      if (response.ok) {
        setSignals(data.signals || []);
      } else {
        setError(data.message || 'Failed to fetch signals');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch signals');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeView === 'summary') fetchSummary();
    else if (activeView === 'products') fetchProducts();
    else if (activeView === 'locations') fetchLocations();
    else if (activeView === 'categories') fetchCategories();
    else if (activeView === 'signals') fetchSignals();
  }, [activeView, locationId, categoryId, riskLevel, severity, signalType, limit, offset]);

  const getRiskClass = (risk) => {
    const r = risk?.toLowerCase() || '';
    if (r === 'critical') return 'risk-critical';
    if (r === 'high') return 'risk-high';
    if (r === 'medium') return 'risk-medium';
    return 'risk-low';
  };

  return (
    <div>
      <h2>Inventory Aging Analysis</h2>
      <p style={{ marginBottom: '20px', color: '#666' }}>
        Analyze inventory aging to identify slow-moving products, cash tied up, and actionable insights.
      </p>

      <div className="sub-tabs">
        <button 
          className={`sub-tab ${activeView === 'summary' ? 'active' : ''}`}
          onClick={() => setActiveView('summary')}
        >
          Summary
        </button>
        <button 
          className={`sub-tab ${activeView === 'products' ? 'active' : ''}`}
          onClick={() => setActiveView('products')}
        >
          Products
        </button>
        <button 
          className={`sub-tab ${activeView === 'locations' ? 'active' : ''}`}
          onClick={() => setActiveView('locations')}
        >
          Locations
        </button>
        <button 
          className={`sub-tab ${activeView === 'categories' ? 'active' : ''}`}
          onClick={() => setActiveView('categories')}
        >
          Categories
        </button>
        <button 
          className={`sub-tab ${activeView === 'signals' ? 'active' : ''}`}
          onClick={() => setActiveView('signals')}
        >
          Actionable Signals
        </button>
      </div>

      <div style={{ marginBottom: '20px', padding: '15px', background: '#f8f9fa', borderRadius: '4px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', fontWeight: '600' }}>Location ID:</label>
            <input
              type="text"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              placeholder="Filter by location"
              style={{ width: '100%', padding: '6px', fontSize: '12px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', fontWeight: '600' }}>Category ID:</label>
            <input
              type="text"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              placeholder="Filter by category"
              style={{ width: '100%', padding: '6px', fontSize: '12px' }}
            />
          </div>
          {activeView === 'products' && (
            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', fontWeight: '600' }}>Risk Level:</label>
              <select
                value={riskLevel}
                onChange={(e) => setRiskLevel(e.target.value)}
                style={{ width: '100%', padding: '6px', fontSize: '12px' }}
              >
                <option value="">All</option>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </div>
          )}
          {activeView === 'signals' && (
            <>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', fontWeight: '600' }}>Severity:</label>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                  style={{ width: '100%', padding: '6px', fontSize: '12px' }}
                >
                  <option value="">All</option>
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                  <option value="CRITICAL">Critical</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', fontWeight: '600' }}>Type:</label>
                <select
                  value={signalType}
                  onChange={(e) => setSignalType(e.target.value)}
                  style={{ width: '100%', padding: '6px', fontSize: '12px' }}
                >
                  <option value="">All</option>
                  <option value="AT_RISK">At Risk</option>
                  <option value="SLOW_MOVING_EXPENSIVE">Slow Moving Expensive</option>
                  <option value="OVERSTOCKED_CATEGORY">Overstocked Category</option>
                </select>
              </div>
            </>
          )}
          {(activeView === 'products' || activeView === 'signals') && (
            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', fontWeight: '600' }}>Limit:</label>
              <input
                type="number"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                style={{ width: '100%', padding: '6px', fontSize: '12px' }}
                min="1"
                max="500"
              />
            </div>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading && <div className="loading">Loading...</div>}

      {activeView === 'summary' && summary && (
        <div>
          <div className="stats-grid">
            <div className="stat-card">
              <h4>Total Cash Tied Up</h4>
              <div className="value">${summary.totalCashTiedUp?.toFixed(2) || '0.00'}</div>
            </div>
            <div className="stat-card">
              <h4>Total Units</h4>
              <div className="value">{summary.totalUnits || 0}</div>
            </div>
          </div>
          <h3>Aging Buckets</h3>
          <table>
            <thead>
              <tr>
                <th>Age Range</th>
                <th>Cash Value</th>
                <th>Units</th>
                <th>Percentage</th>
                <th>Visual</th>
              </tr>
            </thead>
            <tbody>
              {summary.buckets?.map((bucket, idx) => (
                <tr key={idx}>
                  <td><strong>{bucket.bucket?.label || 'N/A'}</strong></td>
                  <td>${bucket.cashValue?.toFixed(2) || '0.00'}</td>
                  <td>{bucket.unitCount || 0}</td>
                  <td>{bucket.percentageOfTotal?.toFixed(1) || '0.0'}%</td>
                  <td style={{ width: '200px' }}>
                    <div className="progress-bar">
                      <div 
                        className="progress-fill" 
                        style={{ width: `${bucket.percentageOfTotal || 0}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeView === 'products' && products.length > 0 && (
        <div>
          <h3>Product Aging Analysis ({products.length})</h3>
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Cash Tied Up</th>
                <th>Units</th>
                <th>Oldest Age (days)</th>
                <th>Risk Level</th>
                <th>Buckets</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.productId}>
                  <td><strong>{product.productName}</strong></td>
                  <td>{product.categoryName || '-'}</td>
                  <td>${product.totalCashTiedUp?.toFixed(2) || '0.00'}</td>
                  <td>{product.totalUnits || 0}</td>
                  <td>{product.oldestBatchAge || 0}</td>
                  <td>
                    <span className={`risk-badge ${getRiskClass(product.riskLevel)}`}>
                      {product.riskLevel || 'LOW'}
                    </span>
                  </td>
                  <td>
                    {product.bucketDistribution?.map((b, i) => (
                      <span key={i} style={{ marginRight: '5px', fontSize: '11px' }}>
                        {b.bucket?.label}: {b.percentageOfTotal?.toFixed(0)}%
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeView === 'locations' && locations.length > 0 && (
        <div>
          <h3>Location Aging Analysis ({locations.length})</h3>
          <table>
            <thead>
              <tr>
                <th>Location</th>
                <th>Cash Tied Up</th>
                <th>Units</th>
                <th>At-Risk Products</th>
                <th>Buckets</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((location) => (
                <tr key={location.locationId}>
                  <td><strong>{location.locationName}</strong></td>
                  <td>${location.totalCashTiedUp?.toFixed(2) || '0.00'}</td>
                  <td>{location.totalUnits || 0}</td>
                  <td>
                    <span className={location.atRiskProducts > 0 ? 'risk-badge risk-high' : 'risk-badge risk-low'}>
                      {location.atRiskProducts || 0}
                    </span>
                  </td>
                  <td>
                    {location.bucketDistribution?.map((b, i) => (
                      <span key={i} style={{ marginRight: '5px', fontSize: '11px' }}>
                        {b.bucket?.label}: ${b.cashValue?.toFixed(0)}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeView === 'categories' && categories.length > 0 && (
        <div>
          <h3>Category Aging Analysis ({categories.length})</h3>
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Cash Tied Up</th>
                <th>Units</th>
                <th>Avg Age (days)</th>
                <th>Buckets</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <tr key={category.categoryId}>
                  <td><strong>{category.categoryName}</strong></td>
                  <td>${category.totalCashTiedUp?.toFixed(2) || '0.00'}</td>
                  <td>{category.totalUnits || 0}</td>
                  <td>{category.averageAge?.toFixed(1) || '0.0'}</td>
                  <td>
                    {category.bucketDistribution?.map((b, i) => (
                      <span key={i} style={{ marginRight: '5px', fontSize: '11px' }}>
                        {b.bucket?.label}: ${b.cashValue?.toFixed(0)}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeView === 'signals' && signals.length > 0 && (
        <div>
          <h3>Actionable Signals ({signals.length})</h3>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Severity</th>
                <th>Entity</th>
                <th>Message</th>
                <th>Cash at Risk</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((signal, idx) => (
                <tr key={idx}>
                  <td>
                    <span className="badge badge-info">
                      {signal.type?.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td>
                    <span className={`risk-badge ${getRiskClass(signal.severity)}`}>
                      {signal.severity}
                    </span>
                  </td>
                  <td>
                    <strong>{signal.entityName}</strong>
                    <br />
                    <small style={{ color: '#666' }}>{signal.entityType}</small>
                  </td>
                  <td>{signal.message}</td>
                  <td>
                    {signal.cashAtRisk ? `$${signal.cashAtRisk.toFixed(2)}` : '-'}
                  </td>
                  <td>
                    <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '12px' }}>
                      {signal.recommendedActions?.map((action, i) => (
                        <li key={i}>{action}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && (
        (activeView === 'summary' && !summary) ||
        (activeView === 'products' && products.length === 0) ||
        (activeView === 'locations' && locations.length === 0) ||
        (activeView === 'categories' && categories.length === 0) ||
        (activeView === 'signals' && signals.length === 0)
      ) && (
        <div style={{ textAlign: 'center', padding: '40px', color: '#666' }}>
          No data available. Make sure you have inventory with quantity &gt; 0.
        </div>
      )}
    </div>
  );
};

