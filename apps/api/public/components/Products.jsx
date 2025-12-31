// Products Component
const { useState, useEffect } = React;

const Products = () => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/products')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setProducts(data.data || []);
        } else {
          setError('Failed to fetch products');
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading products...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div>
      <h2>Products ({products.length})</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Square Product Name</th>
            <th>SKU</th>
            <th>Category</th>
            <th>Mappings</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <tr key={product.id}>
              <td><code>{product.id.substring(0, 8)}...</code></td>
              <td>{product.name}</td>
              <td>{product.squareProductName || '-'}</td>
              <td>{product.sku || '-'}</td>
              <td>{product.category?.name || '-'}</td>
              <td><span className="badge badge-info">{product.catalogMappings?.length || 0}</span></td>
              <td>{new Date(product.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

