// SupplierCostHistory Component
const { useState, useEffect } = React;

const SupplierCostHistory = () => {
  const [costHistory, setCostHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedSupplier, setSelectedSupplier] = useState('');
  const [selectedProduct, setSelectedProduct] = useState('');
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);

  useEffect(() => {
    fetchSuppliers();
  }, []);

  const fetchSuppliers = async () => {
    try {
      const response = await fetch('/admin/inventory/cutover/suppliers');
      const data = await response.json();
      if (data.success) {
        setSuppliers(data.suppliers || []);
      }
    } catch (err) {
      console.error('Failed to fetch suppliers:', err);
    }
  };

  const fetchProducts = async (supplierId) => {
    if (!supplierId) {
      setProducts([]);
      return;
    }
    try {
      const response = await fetch(`/admin/inventory/cutover/suppliers/${supplierId}/products`);
      const data = await response.json();
      if (data.success) {
        setProducts(data.products || []);
      }
    } catch (err) {
      console.error('Failed to fetch products:', err);
    }
  };

  const fetchCostHistory = async (supplierId, productId) => {
    if (!supplierId || !productId) {
      setCostHistory([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/admin/inventory/cutover/suppliers/${supplierId}/products/${productId}/cost-history`);
      const data = await response.json();
      if (data.success) {
        setCostHistory(data.costHistory || []);
      } else {
        setError(data.message || 'Failed to fetch cost history');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch cost history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedSupplier) {
      fetchProducts(selectedSupplier);
      setSelectedProduct('');
      setCostHistory([]);
    }
  }, [selectedSupplier]);

  useEffect(() => {
    if (selectedSupplier && selectedProduct) {
      fetchCostHistory(selectedSupplier, selectedProduct);
    }
  }, [selectedSupplier, selectedProduct]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-semibold text-gray-900">Supplier Cost History</h3>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Supplier
            </label>
            <select
              value={selectedSupplier}
              onChange={(e) => setSelectedSupplier(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            >
              <option value="">-- Select a supplier --</option>
              {suppliers.filter(s => s.isActive).map(supplier => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Product
            </label>
            <select
              value={selectedProduct}
              onChange={(e) => setSelectedProduct(e.target.value)}
              disabled={!selectedSupplier}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
            >
              <option value="">-- Select a product --</option>
              {products.map(product => (
                <option key={product.id} value={product.productId || product.id}>
                  {product.productName || product.name || 'N/A'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {loading && (
          <div className="text-center py-8 text-gray-500">
            Loading cost history...
          </div>
        )}

        {!loading && selectedSupplier && selectedProduct && costHistory.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No cost history found for this product.
          </div>
        )}

        {!loading && selectedSupplier && selectedProduct && costHistory.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Effective Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Cost
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created At
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {costHistory.map((history, idx) => (
                  <tr key={idx}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {history.effectiveAt ? new Date(history.effectiveAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      ${history.cost ? parseFloat(history.cost).toFixed(2) : '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {history.createdAt ? new Date(history.createdAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

