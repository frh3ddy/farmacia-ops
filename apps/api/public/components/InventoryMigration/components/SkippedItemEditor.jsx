// Skipped Item Editor Component - Inline editing for skipped items
const SkippedItemEditor = ({
  result,
  editedResults,
  setEditedResults,
  editingSkippedItem,
  setEditingSkippedItem,
  allSuppliers,
  openAutocomplete,
  setOpenAutocomplete,
  supplierSuggestions,
  setSupplierSuggestions,
  dropdownSelectionRef,
  extractionSessionId,
  extractionResult,
  currentCutoverId,
  getSupplierSuggestions,
  setExtractionResults,
  setCostApprovals,
  setError,
}) => {
  // Helper function to format cents to dollars
  const formatCentsToDollars = (cents) => {
    if (cents === null || cents === undefined) return '0.00';
    return (cents / 100).toFixed(2);
  };

  // Helper function to format currency with symbol
  const formatCurrency = (cents, currency = 'USD') => {
    const amount = formatCentsToDollars(cents);
    return `$${amount}`;
  };

  const isEditing = editingSkippedItem === result.productId;
  const edited = editedResults[result.productId] || result;
  
  const supplierName = result.selectedSupplierName;
  const currentCost = edited.selectedCost !== null && edited.selectedCost !== undefined 
    ? edited.selectedCost 
    : result.selectedCost || 0;
  const currentSupplier = edited.selectedSupplierName || supplierName;

  const handleApprove = async () => {
    const edited = editedResults[result.productId] || result;
    const newCost = edited.selectedCost !== null && edited.selectedCost !== undefined 
      ? edited.selectedCost 
      : result.selectedCost || 0;
    const newSupplierName = edited.selectedSupplierName || result.selectedSupplierName || supplierName;
    
    if (!newCost || newCost <= 0) {
      setError('Please enter a valid cost');
      return;
    }
    
    if (!newSupplierName) {
      setError('Please enter a supplier name');
      return;
    }
    
    const cutoverId = currentCutoverId || extractionResult?.cutoverId || extractionSessionId;
    if (!cutoverId) {
      setError('Missing cutover ID');
      return;
    }
    
    try {
      const response = await (window.authFetch || fetch)('/admin/inventory/cutover/approve-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cutoverId: cutoverId,
          productId: result.productId,
          cost: newCost,
          source: 'MANUAL_OVERRIDE',
          notes: `Supplier: ${newSupplierName}`,
          extractedEntries: result.extractedEntries || [],
          selectedSupplierId: edited.selectedSupplierId || result.selectedSupplierId,
          selectedSupplierName: newSupplierName,
        }),
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to approve item');
      }
      
      setExtractionResults(prev => prev.map(r => 
        r.productId === result.productId ? { 
          ...r, 
          migrationStatus: 'APPROVED',
          selectedCost: newCost,
          selectedSupplierName: newSupplierName,
          selectedSupplierId: edited.selectedSupplierId || result.selectedSupplierId,
        } : r
      ));
      
      if (extractionSessionId) {
        const sessionResponse = await fetch(`/admin/inventory/cutover/extraction-session/${extractionSessionId}`);
        if (sessionResponse.ok) {
          const sessionData = await sessionResponse.json();
          if (sessionData.success && sessionData.session && sessionData.session.costApprovals) {
            const approvalsMap = {};
            sessionData.session.costApprovals
              .filter(approval => approval.productId === result.productId)
              .forEach(approval => {
                approvalsMap[approval.productId] = approval;
              });
            setCostApprovals(prev => ({ ...prev, ...approvalsMap }));
          }
        }
      }
      
      setEditingSkippedItem(null);
    } catch (err) {
      setError(err.message || 'Failed to approve item');
    }
  };

  return (
    <div className={`border border-gray-200 rounded-lg p-4 ${isEditing ? 'bg-white opacity-100' : 'bg-gray-50 opacity-60'}`}>
      <div className="flex items-start gap-4">
        {result.imageUrl && (
          <img src={result.imageUrl} alt={result.productName} className={`w-20 h-20 object-cover rounded ${isEditing ? '' : 'grayscale'}`} />
        )}
        <div className="flex-1">
          <h3 className="font-semibold text-gray-900">{result.productName}</h3>
          <div className="mt-2 space-y-3">
            <p className="text-sm text-gray-600">Status: <span className="text-red-600 font-medium">Discarded</span></p>
            
            {/* Selling Price - display only */}
            {result.sellingPrice && result.sellingPrice.priceCents !== null && result.sellingPrice.priceCents !== undefined && (
              <div>
                <label className="text-xs text-gray-600 font-medium">Selling Price:</label>
                <p className="text-sm font-semibold text-gray-900 mt-1">
                  {result.sellingPriceRange && result.sellingPriceRange.minCents !== result.sellingPriceRange.maxCents
                    ? `${formatCurrency(result.sellingPrice.priceCents, result.sellingPrice.currency)} – ${formatCurrency(result.sellingPriceRange.maxCents, result.sellingPriceRange.currency)}`
                    : formatCurrency(result.sellingPrice.priceCents, result.sellingPrice.currency)}
                </p>
              </div>
            )}
            
            {/* Cost - editable */}
            <div>
              <label className="text-xs text-gray-600 font-medium">Cost:</label>
              {isEditing ? (
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={currentCost || ''}
                  onChange={(e) => {
                    const newCost = parseFloat(e.target.value) || 0;
                    setEditedResults(prev => {
                      const newEdited = { ...prev };
                      if (!newEdited[result.productId]) {
                        newEdited[result.productId] = { ...result };
                      }
                      newEdited[result.productId].selectedCost = newCost;
                      return newEdited;
                    });
                  }}
                  className="mt-1 w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              ) : (
                <p className="text-sm text-gray-700 mt-1">
                  {currentCost ? `$${typeof currentCost === 'number' ? currentCost.toFixed(2) : parseFloat(currentCost || 0).toFixed(2)}` : 'Not specified'}
                </p>
              )}
            </div>
            
            {/* Supplier - editable */}
            <div>
              <label className="text-xs text-gray-600 font-medium">Supplier:</label>
              {isEditing ? (
                <div className="relative mt-1">
                  <input
                    type="text"
                    value={edited.selectedSupplierName ?? currentSupplier ?? ''}
                    onChange={(e) => {
                      const newValue = e.target.value;
                      setEditedResults(prev => {
                        const newEdited = { ...prev };
                        if (!newEdited[result.productId]) {
                          newEdited[result.productId] = { ...result };
                        }
                        newEdited[result.productId].selectedSupplierName = newValue;
                        return newEdited;
                      });
                      
                      const localSuggestions = getSupplierSuggestions(newValue, '');
                      if (localSuggestions.length > 0) {
                        setOpenAutocomplete(prev => ({ ...prev, [`skipped_${result.productId}`]: true }));
                        setSupplierSuggestions(prev => ({ ...prev, [`skipped_${result.productId}`]: localSuggestions }));
                      } else if (newValue.length > 1) {
                        fetch(`/admin/inventory/cutover/suppliers/suggest?q=${encodeURIComponent(newValue)}`)
                          .then(res => res.json())
                          .then(data => {
                            if (data.success) {
                              setOpenAutocomplete(prev => ({ ...prev, [`skipped_${result.productId}`]: true }));
                              setSupplierSuggestions(prev => ({ ...prev, [`skipped_${result.productId}`]: data.suppliers }));
                            }
                          });
                      } else {
                        setOpenAutocomplete(prev => {
                          const newState = { ...prev };
                          delete newState[`skipped_${result.productId}`];
                          return newState;
                        });
                      }
                    }}
                    onBlur={() => {
                      setTimeout(() => {
                        if (!dropdownSelectionRef.current[`skipped_${result.productId}`]) {
                          setOpenAutocomplete(prev => {
                            const newState = { ...prev };
                            delete newState[`skipped_${result.productId}`];
                            return newState;
                          });
                        }
                        dropdownSelectionRef.current[`skipped_${result.productId}`] = false;
                      }, 200);
                    }}
                    className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="Enter supplier name"
                  />
                  {openAutocomplete[`skipped_${result.productId}`] && supplierSuggestions[`skipped_${result.productId}`] && supplierSuggestions[`skipped_${result.productId}`].length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-auto">
                      {supplierSuggestions[`skipped_${result.productId}`].map((suggestion, sIdx) => (
                        <div
                          key={sIdx}
                          className="px-3 py-2 hover:bg-gray-100 cursor-pointer text-sm"
                          onMouseDown={() => {
                            dropdownSelectionRef.current[`skipped_${result.productId}`] = true;
                            setEditedResults(prev => {
                              const newEdited = { ...prev };
                              if (!newEdited[result.productId]) {
                                newEdited[result.productId] = { ...result };
                              }
                              newEdited[result.productId].selectedSupplierName = suggestion.name;
                              newEdited[result.productId].selectedSupplierId = suggestion.id;
                              return newEdited;
                            });
                            setOpenAutocomplete(prev => {
                              const newState = { ...prev };
                              delete newState[`skipped_${result.productId}`];
                              return newState;
                            });
                          }}
                        >
                          <div className="font-medium">{suggestion.name}</div>
                          {suggestion.contactInfo && (
                            <div className="text-xs text-gray-500">{suggestion.contactInfo}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-700 mt-1">
                  {currentSupplier || 'Not specified'}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {isEditing ? (
            <>
              <button
                onClick={handleApprove}
                className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-sm"
              >
                Approve
              </button>
              <button
                onClick={() => {
                  setEditingSkippedItem(null);
                  setEditedResults(prev => {
                    const newEdited = { ...prev };
                    delete newEdited[result.productId];
                    return newEdited;
                  });
                }}
                className="px-3 py-1 border border-gray-300 rounded text-sm"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setEditingSkippedItem(result.productId)}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm"
            >
              Edit
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
