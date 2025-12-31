// SupplierProducts Component
const { useState, useEffect } = React;

const SupplierProducts = () => {
  const [supplierProducts, setSupplierProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedSupplier, setSelectedSupplier] = useState('');
  const [suppliers, setSuppliers] = useState([]);

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

  const fetchSupplierProducts = async (supplierId) => {
    if (!supplierId) {
      setSupplierProducts([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/admin/inventory/cutover/suppliers/${supplierId}/products`);
      const data = await response.json();
      if (data.success) {
        setSupplierProducts(data.products || []);
      } else {
        setError(data.message || 'Failed to fetch supplier products');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch supplier products');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedSupplier) {
      fetchSupplierProducts(selectedSupplier);
    }
  }, [selectedSupplier]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-semibold text-gray-900">Supplier Products</h3>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select Supplier
          </label>
          <select
            value={selectedSupplier}
            onChange={(e) => setSelectedSupplier(e.target.value)}
            className="w-full md:w-64 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
          >
            <option value="">-- Select a supplier --</option>
            {suppliers.filter(s => s.isActive).map(supplier => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
        </div>

        {loading && (
          <div className="text-center py-8 text-gray-500">
            Loading supplier products...
          </div>
        )}

        {!loading && selectedSupplier && supplierProducts.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No products found for this supplier.
          </div>
        )}

        {!loading && selectedSupplier && supplierProducts.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Product Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    SKU
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Cost
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Last Updated
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {supplierProducts.map((product) => (
                  <tr key={product.id}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {product.productName || product.name || 'N/A'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {product.sku || '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      ${product.cost ? parseFloat(product.cost).toFixed(2) : '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {product.updatedAt ? new Date(product.updatedAt).toLocaleDateString() : '—'}
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

