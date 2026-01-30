// Products Component with Supplier History
const { useState, useEffect } = React;

const Products = () => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Supplier history state
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [productSuppliers, setProductSuppliers] = useState([]);
  const [supplierCostHistories, setSupplierCostHistories] = useState([]);
  const [expandedSuppliers, setExpandedSuppliers] = useState(new Set());
  const [loadingSuppliers, setLoadingSuppliers] = useState(false);
  const [suppliersError, setSuppliersError] = useState(null);

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

  // Fetch suppliers and cost histories when a product is selected
  useEffect(() => {
    if (!selectedProductId) {
      setProductSuppliers([]);
      setSupplierCostHistories([]);
      setExpandedSuppliers(new Set());
      return;
    }

    setLoadingSuppliers(true);
    setSuppliersError(null);

    // Fetch suppliers
    const fetchSuppliers = fetch(`/admin/inventory/cutover/products/${selectedProductId}/suppliers`)
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setProductSuppliers(data.suppliers || []);
        } else {
          throw new Error(data.message || 'Failed to fetch suppliers');
        }
      });

    // Fetch cost histories
    const fetchCostHistories = fetch(`/admin/inventory/cutover/products/${selectedProductId}/suppliers/cost-history`)
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setSupplierCostHistories(data.suppliers || []);
        } else {
          throw new Error(data.message || 'Failed to fetch cost histories');
        }
      });

    Promise.all([fetchSuppliers, fetchCostHistories])
      .catch(err => {
        setSuppliersError(err.message || 'Failed to load supplier data');
        console.error('Error fetching supplier data:', err);
      })
      .finally(() => setLoadingSuppliers(false));
  }, [selectedProductId]);

  const toggleSupplierExpansion = (supplierId) => {
    setExpandedSuppliers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(supplierId)) {
        newSet.delete(supplierId);
      } else {
        newSet.add(supplierId);
      }
      return newSet;
    });
  };

  const selectedProduct = products.find(p => p.id === selectedProductId);
  const getCostHistoryForSupplier = (supplierId) => {
    return supplierCostHistories.find(s => s.supplierId === supplierId)?.costHistory || [];
  };

  if (loading) return <div className="loading">Loading products...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-900">Products ({products.length})</h2>
        {selectedProductId && (
          <button
            onClick={() => setSelectedProductId(null)}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Clear Selection
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Product Table */}
        <div className={selectedProductId ? 'lg:col-span-1' : 'lg:col-span-2'}>
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ID</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Square Product Name</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">SKU</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Suppliers</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Mappings</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {products.map((product) => (
                    <tr
                      key={product.id}
                      onClick={() => setSelectedProductId(product.id)}
                      className={`cursor-pointer hover:bg-gray-50 transition-colors ${
                        selectedProductId === product.id ? 'bg-blue-50 border-l-4 border-blue-500' : ''
                      }`}
                    >
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                        <code className="text-xs">{product.id.substring(0, 8)}...</code>
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{product.name}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{product.squareProductName || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{product.sku || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{product.category?.name || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {product.supplierCount > 0 ? (
                          <div className="flex items-center gap-1">
                            <span className="text-green-600" title="Has suppliers">
                              ✓
                            </span>
                            <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded-full">
                              {product.supplierCount}
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-400" title="No suppliers">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        <span className="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded-full">
                          {product.catalogMappings?.length || 0}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {new Date(product.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Supplier Details Panel */}
        {selectedProductId && (
          <div className="lg:col-span-1">
            <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
              {loadingSuppliers ? (
                <div className="text-center py-8 text-gray-500">
                  Loading supplier data...
                </div>
              ) : suppliersError ? (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                  {suppliersError}
                </div>
              ) : (
                <>
                  {/* Product Info */}
                  <div className="border-b border-gray-200 pb-4">
                    <h3 className="text-lg font-semibold text-gray-900 mb-1">
                      {selectedProduct?.name || 'Unknown Product'}
                    </h3>
                    {selectedProduct?.squareProductName && (
                      <p className="text-sm text-gray-600">{selectedProduct.squareProductName}</p>
                    )}
                    {selectedProduct?.sku && (
                      <p className="text-xs text-gray-500 mt-1">SKU: {selectedProduct.sku}</p>
                    )}
                  </div>

                  {/* Suppliers List */}
                  {productSuppliers.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      No suppliers found for this product.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
                        Suppliers ({productSuppliers.length})
                      </h4>
                      {productSuppliers.map((supplier) => {
                        const costHistory = getCostHistoryForSupplier(supplier.id);
                        const isExpanded = expandedSuppliers.has(supplier.id);
                        
                        return (
                          <div
                            key={supplier.id}
                            className="border border-gray-200 rounded-lg overflow-hidden"
                          >
                            {/* Supplier Header */}
                            <div
                              className="p-4 bg-gray-50 hover:bg-gray-100 cursor-pointer transition-colors"
                              onClick={() => toggleSupplierExpansion(supplier.id)}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-gray-900">{supplier.name}</span>
                                    {supplier.isPreferred && (
                                      <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 rounded-full">
                                        Preferred
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-1 text-sm text-gray-600">
                                    Current Cost: <span className="font-semibold text-gray-900">${parseFloat(supplier.cost).toFixed(2)}</span>
                                  </div>
                                  {supplier.contactInfo && (
                                    <div className="mt-1 text-xs text-gray-500">{supplier.contactInfo}</div>
                                  )}
                                </div>
                                <div className="ml-4">
                                  {costHistory.length > 0 && (
                                    <span className="text-xs text-gray-500">
                                      {isExpanded ? '▼' : '▶'} {costHistory.length} history entries
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Cost History Table */}
                            {isExpanded && costHistory.length > 0 && (
                              <div className="border-t border-gray-200 bg-white">
                                <div className="overflow-x-auto">
                                  <table className="min-w-full divide-y divide-gray-200">
                                    <thead className="bg-gray-50">
                                      <tr>
                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                          Effective Date
                                        </th>
                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                          Cost
                                        </th>
                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                          Source
                                        </th>
                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                          Status
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-gray-200">
                                      {costHistory.map((history, idx) => (
                                        <tr
                                          key={history.id || idx}
                                          className={history.isCurrent ? 'bg-blue-50' : ''}
                                        >
                                          <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                                            {history.effectiveAt
                                              ? new Date(history.effectiveAt).toLocaleDateString()
                                              : '—'}
                                          </td>
                                          <td className="px-4 py-2 whitespace-nowrap text-sm font-medium text-gray-900">
                                            ${parseFloat(history.cost).toFixed(2)}
                                          </td>
                                          <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-600">
                                            {history.source || '—'}
                                          </td>
                                          <td className="px-4 py-2 whitespace-nowrap">
                                            {history.isCurrent && (
                                              <span className="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-800 rounded-full">
                                                Current
                                              </span>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                            {isExpanded && costHistory.length === 0 && (
                              <div className="p-4 text-center text-sm text-gray-500 border-t border-gray-200">
                                No cost history available for this supplier.
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
