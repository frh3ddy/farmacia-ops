// Suppliers Component
const { useState, useEffect } = React;

const Suppliers = () => {
  const [activeSubsection, setActiveSubsection] = useState('management'); // 'management', 'products', 'cost-history'
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({ name: '', initials: [], contactInfo: '', isActive: true });
  const [newInitial, setNewInitial] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [filterActive, setFilterActive] = useState(true);

  const fetchSuppliers = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/admin/inventory/cutover/suppliers');
      const data = await response.json();
      if (data.success) {
        setSuppliers(data.suppliers);
      } else {
        setError(data.message || 'Failed to fetch suppliers');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch suppliers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSuppliers();
  }, []);

  const handleCreate = async () => {
    if (!formData.name.trim()) {
      setError('Supplier name is required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/admin/inventory/cutover/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name.trim(),
          initials: formData.initials.filter(i => i && i.trim().length > 0).map(i => i.trim()),
          contactInfo: formData.contactInfo.trim() || null,
        }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchSuppliers();
        setFormData({ name: '', initials: [], contactInfo: '', isActive: true });
        setNewInitial('');
        setShowAddForm(false);
      } else {
        setError(data.message || 'Failed to create supplier');
      }
    } catch (err) {
      setError(err.message || 'Failed to create supplier');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async (id) => {
    if (!formData.name.trim()) {
      setError('Supplier name is required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/admin/inventory/cutover/suppliers/${id}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name.trim(),
          initials: formData.initials.filter(i => i && i.trim().length > 0).map(i => i.trim()),
          contactInfo: formData.contactInfo.trim() || null,
          isActive: formData.isActive,
        }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchSuppliers();
        setEditingId(null);
        setFormData({ name: '', initials: [], contactInfo: '', isActive: true });
        setNewInitial('');
      } else {
        setError(data.message || 'Failed to update supplier');
      }
    } catch (err) {
      setError(err.message || 'Failed to update supplier');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to deactivate this supplier?')) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/admin/inventory/cutover/suppliers/${id}/delete`, {
        method: 'POST',
      });
      const data = await response.json();
      if (data.success) {
        await fetchSuppliers();
      } else {
        setError(data.message || 'Failed to delete supplier');
      }
    } catch (err) {
      setError(err.message || 'Failed to delete supplier');
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (supplier) => {
    setEditingId(supplier.id);
    setFormData({
      name: supplier.name,
      initials: Array.isArray(supplier.initials) ? supplier.initials : (supplier.initials ? [supplier.initials] : []),
      contactInfo: supplier.contactInfo || '',
      isActive: supplier.isActive,
    });
    setNewInitial('');
    setShowAddForm(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setFormData({ name: '', initials: [], contactInfo: '', isActive: true });
    setNewInitial('');
    setShowAddForm(false);
  };

  const filteredSuppliers = filterActive 
    ? suppliers.filter(s => s.isActive)
    : suppliers;

  return (
    <div className="max-w-7xl mx-auto bg-white rounded-xl shadow-sm p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Suppliers</h2>
        {/* Submenu Navigation */}
        <div className="flex gap-2 border-b-2 border-gray-200">
          <button
            onClick={() => setActiveSubsection('management')}
            className={`px-5 py-3 font-medium text-sm border-b-2 transition-colors ${
              activeSubsection === 'management'
                ? 'border-primary text-primary font-semibold'
                : 'border-transparent text-gray-600 hover:text-primary'
            }`}
          >
            Management
          </button>
          <button
            onClick={() => setActiveSubsection('products')}
            className={`px-5 py-3 font-medium text-sm border-b-2 transition-colors ${
              activeSubsection === 'products'
                ? 'border-primary text-primary font-semibold'
                : 'border-transparent text-gray-600 hover:text-primary'
            }`}
          >
            Supplier Products
          </button>
          <button
            onClick={() => setActiveSubsection('cost-history')}
            className={`px-5 py-3 font-medium text-sm border-b-2 transition-colors ${
              activeSubsection === 'cost-history'
                ? 'border-primary text-primary font-semibold'
                : 'border-transparent text-gray-600 hover:text-primary'
            }`}
          >
            Supplier Cost History
          </button>
        </div>
      </div>

      {activeSubsection === 'management' && (
        <>
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-semibold text-gray-900">Supplier Management</h3>
            <div className="flex gap-3">
              <button
                onClick={() => setFilterActive(!filterActive)}
                className={`px-4 py-2 rounded-md text-sm font-medium ${
                  filterActive
                    ? 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    : 'bg-primary text-white hover:bg-primary-hover'
                }`}
              >
                {filterActive ? 'Show All' : 'Show Active Only'}
              </button>
              <button
                onClick={() => {
                  cancelEdit();
                  setShowAddForm(true);
                }}
                className="px-4 py-2 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover"
                disabled={loading || editingId}
              >
                + Add Supplier
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
              {error}
            </div>
          )}

          {(showAddForm || editingId) && (
            <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                {editingId ? 'Edit Supplier' : 'Add New Supplier'}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Supplier Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="e.g., Levi Pharmaceuticals"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Initials/Abbreviations
                  </label>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={newInitial}
                      onChange={(e) => setNewInitial(e.target.value)}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const trimmed = newInitial.trim();
                          if (trimmed && !formData.initials.includes(trimmed)) {
                            setFormData({ ...formData, initials: [...formData.initials, trimmed] });
                            setNewInitial('');
                          }
                        }
                      }}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                      placeholder="e.g., L, Lev, Levi"
                      maxLength={20}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const trimmed = newInitial.trim();
                        if (trimmed && !formData.initials.includes(trimmed)) {
                          setFormData({ ...formData, initials: [...formData.initials, trimmed] });
                          setNewInitial('');
                        }
                      }}
                      className="px-4 py-2 bg-primary text-white rounded-md hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 transition-colors"
                    >
                      Add
                    </button>
                  </div>
                  {formData.initials.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {formData.initials.map((initial, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center gap-1 px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-medium"
                        >
                          {initial}
                          <button
                            type="button"
                            onClick={() => {
                              setFormData({
                                ...formData,
                                initials: formData.initials.filter((_, i) => i !== idx),
                              });
                            }}
                            className="ml-1 text-blue-600 hover:text-blue-800 focus:outline-none"
                            aria-label={`Remove ${initial}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="mt-1 text-xs text-gray-500">Add multiple initials used for cost extraction (e.g., L, Lev, Levi)</p>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Contact Info
                  </label>
                  <input
                    type="text"
                    value={formData.contactInfo}
                    onChange={(e) => setFormData({ ...formData, contactInfo: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="Email, phone, or address"
                  />
                </div>
                {editingId && (
                  <div>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={formData.isActive}
                        onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                        className="rounded border-gray-300 text-primary focus:ring-primary"
                      />
                      <span className="text-sm font-medium text-gray-700">Active</span>
                    </label>
                  </div>
                )}
              </div>
              <div className="mt-4 flex gap-3">
                <button
                  onClick={editingId ? () => handleUpdate(editingId) : handleCreate}
                  disabled={loading || !formData.name.trim()}
                  className="px-4 py-2 bg-primary text-white rounded-md text-sm font-medium hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Saving...' : editingId ? 'Update' : 'Create'}
                </button>
                <button
                  onClick={cancelEdit}
                  disabled={loading}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-300 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {loading && !suppliers.length ? (
            <div className="text-center py-12 text-gray-500">Loading suppliers...</div>
          ) : filteredSuppliers.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              {filterActive ? 'No active suppliers found.' : 'No suppliers found.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Name
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Initials
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Contact Info
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredSuppliers.map((supplier) => (
                    <tr key={supplier.id} className={!supplier.isActive ? 'bg-gray-50 opacity-60' : ''}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{supplier.name}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-600">
                          {Array.isArray(supplier.initials) && supplier.initials.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {supplier.initials.map((init, idx) => (
                                <span key={idx} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                  {init}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-600">{supplier.contactInfo || '—'}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          supplier.isActive
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {supplier.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                        <div className="flex gap-2">
                          <button
                            onClick={() => startEdit(supplier)}
                            disabled={loading || editingId || showAddForm}
                            className="text-primary hover:text-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Edit
                          </button>
                          {supplier.isActive && (
                            <button
                              onClick={() => handleDelete(supplier.id)}
                              disabled={loading || editingId}
                              className="text-red-600 hover:text-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Deactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 text-sm text-gray-500">
            Showing {filteredSuppliers.length} of {suppliers.length} supplier(s)
          </div>
        </>
      )}

      {activeSubsection === 'products' && (
        <SupplierProducts />
      )}

      {activeSubsection === 'cost-history' && (
        <SupplierCostHistory />
      )}
    </div>
  );
};
