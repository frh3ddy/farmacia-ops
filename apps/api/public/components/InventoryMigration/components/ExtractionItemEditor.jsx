// Extraction Item Editor Component - Two-column layout with table and product review
const ExtractionItemEditor = ({
  result,
  groupedResults,
  currentExtractingIndex,
  setCurrentExtractingIndex,
  editedResults,
  setEditedResults,
  allSuppliers,
  openAutocomplete,
  setOpenAutocomplete,
  supplierSuggestions,
  setSupplierSuggestions,
  dropdownSelectionRef,
  cutoverDate,
  getSupplierSuggestions,
  onApprove,
  onDiscard,
  setError,
}) => {
  if (!result) {
    if (currentExtractingIndex >= groupedResults.extracting.length) {
      setCurrentExtractingIndex(Math.max(0, groupedResults.extracting.length - 1));
    }
    return null;
  }

  const edited = editedResults[result.productId] || result;
  const hasExtraction = edited.extractedEntries && edited.extractedEntries.length > 0;
  const selectedEntry = edited.extractedEntries?.find(e => e.isSelected) || 
    (edited.extractedEntries?.length > 0 ? edited.extractedEntries[edited.extractedEntries.length - 1] : null);
  const displayCost = edited.selectedCost !== null && edited.selectedCost !== undefined 
    ? edited.selectedCost 
    : (selectedEntry ? (selectedEntry.editedCost !== null && selectedEntry.editedCost !== undefined ? selectedEntry.editedCost : selectedEntry.amount) : null);
  const displaySupplier = edited.selectedSupplierName || (selectedEntry ? (selectedEntry.editedSupplierName || selectedEntry.supplier) : null) || '';

  return (
    <div className="space-y-4">
      {groupedResults.extracting.length > 0 ? (
        <div className="space-y-4">
          <div className="border border-gray-200 rounded-lg bg-white">
            <div className="grid grid-cols-3 gap-6 p-6">
              {/* Left Column: Extracted Costs Table */}
              <div className="space-y-4 col-span-2">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">Extracted Costs</h3>
                    <p className="text-sm text-gray-600">Select the most accurate cost entry from the list below.</p>
                  </div>
                  {hasExtraction && (
                    <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-medium">
                      {edited.extractedEntries?.length || 0} Found
                    </span>
                  )}
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 text-lg">{result.productName}</h3>
                  {result.originalDescription && result.originalDescription !== result.productName && (
                    <p className="text-sm text-gray-500 mt-1">{result.originalDescription}</p>
                  )}
                </div>

                {/* Extracted Entries Table */}
                {hasExtraction ? (
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 w-12"></th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-700">SUPPLIER NAME</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-700">COST</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-700">DATE</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-700">SOURCE</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 bg-white">
                        {edited.extractedEntries.map((entry, idx) => {
                          const isSelected = entry.isSelected !== undefined ? entry.isSelected : (idx === edited.extractedEntries.length - 1);
                          const entryKey = `${result.productId}_${idx}`;
                          const suggestions = supplierSuggestions[entryKey] || [];
                          const showAutocomplete = openAutocomplete[entryKey];

                          return (
                            <tr key={idx} className={isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}>
                              {/* Radio button column */}
                              <td className="px-4 py-3">
                                <input
                                  type="radio"
                                  name={`entry_${result.productId}`}
                                  checked={isSelected}
                                  onChange={() => {
                                    setEditedResults(prev => {
                                      const newResults = { ...prev };
                                      if (!newResults[result.productId]) {
                                        newResults[result.productId] = { ...result };
                                      }
                                      if (!newResults[result.productId].extractedEntries) {
                                        newResults[result.productId].extractedEntries = [...result.extractedEntries];
                                      }
                                      newResults[result.productId].extractedEntries = newResults[result.productId].extractedEntries.map((e, i) => ({
                                        ...e,
                                        isSelected: i === idx
                                      }));
                                      newResults[result.productId].selectedCost = entry.editedCost !== null && entry.editedCost !== undefined ? entry.editedCost : entry.amount;
                                      newResults[result.productId].selectedSupplierName = entry.editedSupplierName || entry.supplier;
                                      newResults[result.productId].selectedSupplierId = entry.supplierId;
                                      return newResults;
                                    });
                                  }}
                                  className="w-4 h-4 text-primary"
                                />
                              </td>
                              
                              {/* Supplier Name column */}
                              <td className="px-4 py-3">
                                <div className="relative">
                                  <input
                                    type="text"
                                    value={entry.editedSupplierName ?? entry.supplier ?? ''}
                                    onChange={(e) => {
                                      const newValue = e.target.value;
                                      setEditedResults(prev => {
                                        const newResults = { ...prev };
                                        if (!newResults[result.productId]) {
                                          newResults[result.productId] = { ...result };
                                        }
                                        if (!newResults[result.productId].extractedEntries) {
                                          newResults[result.productId].extractedEntries = [...result.extractedEntries];
                                        }
                                        newResults[result.productId].extractedEntries[idx] = {
                                          ...newResults[result.productId].extractedEntries[idx],
                                          editedSupplierName: newValue,
                                        };
                                        if (isSelected) {
                                          newResults[result.productId].selectedSupplierName = newValue;
                                        }
                                        return newResults;
                                      });
                                      
                                      const localSuggestions = getSupplierSuggestions(newValue, entry.supplier);
                                      if (localSuggestions.length > 0) {
                                        setOpenAutocomplete(prev => ({ ...prev, [entryKey]: true }));
                                        setSupplierSuggestions(prev => ({ ...prev, [entryKey]: localSuggestions }));
                                      } else if (newValue.length > 1) {
                                        fetch(`/admin/inventory/cutover/suppliers/suggest?q=${encodeURIComponent(newValue)}`)
                                          .then(res => res.json())
                                          .then(data => {
                                            if (data.success) {
                                              setOpenAutocomplete(prev => ({ ...prev, [entryKey]: true }));
                                              setSupplierSuggestions(prev => ({ ...prev, [entryKey]: data.suppliers }));
                                            }
                                          })
                                          .catch(err => console.error('Failed to fetch suggestions:', err));
                                      } else {
                                        setOpenAutocomplete(prev => {
                                          const newState = { ...prev };
                                          delete newState[entryKey];
                                          return newState;
                                        });
                                      }
                                    }}
                                    onBlur={() => {
                                      setTimeout(() => {
                                        if (!dropdownSelectionRef.current[entryKey]) {
                                          setOpenAutocomplete(prev => {
                                            const newState = { ...prev };
                                            delete newState[entryKey];
                                            return newState;
                                          });
                                        }
                                        dropdownSelectionRef.current[entryKey] = false;
                                      }, 200);
                                    }}
                                    className={`w-full px-2 py-1 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary ${
                                      isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
                                    }`}
                                    placeholder="Supplier name"
                                  />
                                  {entry.matchedByInitial && (
                                    <div className="text-xs text-blue-600 mt-1">
                                      Matched by initial: {entry.supplier}
                                    </div>
                                  )}
                                  {showAutocomplete && suggestions.length > 0 && (
                                    <div className="absolute z-20 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-auto">
                                      {suggestions.map((suggestion, sIdx) => (
                                        <div
                                          key={sIdx}
                                          className="px-3 py-2 hover:bg-gray-100 cursor-pointer text-sm"
                                          onMouseDown={() => {
                                            dropdownSelectionRef.current[entryKey] = true;
                                            setEditedResults(prev => {
                                              const newResults = { ...prev };
                                              if (!newResults[result.productId]) {
                                                newResults[result.productId] = { ...result };
                                              }
                                              if (!newResults[result.productId].extractedEntries) {
                                                newResults[result.productId].extractedEntries = [...result.extractedEntries];
                                              }
                                              newResults[result.productId].extractedEntries[idx] = {
                                                ...newResults[result.productId].extractedEntries[idx],
                                                editedSupplierName: suggestion.name,
                                                supplierId: suggestion.id,
                                              };
                                              if (isSelected) {
                                                newResults[result.productId].selectedSupplierName = suggestion.name;
                                                newResults[result.productId].selectedSupplierId = suggestion.id;
                                              }
                                              return newResults;
                                            });
                                            setOpenAutocomplete(prev => {
                                              const newState = { ...prev };
                                              delete newState[entryKey];
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
                              </td>
                              
                              {/* Cost column */}
                              <td className="px-4 py-3">
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={entry.editedCost !== null && entry.editedCost !== undefined ? entry.editedCost : entry.amount}
                                  onChange={(e) => {
                                    const newCost = parseFloat(e.target.value) || 0;
                                    if (newCost < 0) {
                                      setError('Cost cannot be negative');
                                      return;
                                    }
                                    if (newCost === 0) {
                                      if (!window.confirm('Cost is zero. Are you sure?')) {
                                        return;
                                      }
                                    }
                                    setEditedResults(prev => {
                                      const newResults = { ...prev };
                                      if (!newResults[result.productId]) {
                                        newResults[result.productId] = { ...result };
                                      }
                                      if (!newResults[result.productId].extractedEntries) {
                                        newResults[result.productId].extractedEntries = [...result.extractedEntries];
                                      }
                                      newResults[result.productId].extractedEntries[idx] = {
                                        ...newResults[result.productId].extractedEntries[idx],
                                        editedCost: newCost,
                                      };
                                      if (isSelected) {
                                        newResults[result.productId].selectedCost = newCost;
                                      }
                                      return newResults;
                                    });
                                  }}
                                  className={`w-full px-2 py-1 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary ${
                                    isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
                                  }`}
                                />
                              </td>
                              
                              {/* Date column */}
                              <td className="px-4 py-3">
                                {(() => {
                                  let extractedDate = null;
                                  if (entry.month) {
                                    let year = null;
                                    const yearMatch = entry.originalLine?.match(/\b(19|20)\d{2}\b/);
                                    if (yearMatch) {
                                      year = parseInt(yearMatch[0]);
                                    } else if (cutoverDate) {
                                      year = new Date(cutoverDate).getFullYear();
                                    }
                                    if (year) {
                                      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                                        'July', 'August', 'September', 'October', 'November', 'December'];
                                      const monthIndex = monthNames.indexOf(entry.month);
                                      if (monthIndex !== -1) {
                                        const date = new Date(year, monthIndex, 1);
                                        extractedDate = date.toISOString().split('T')[0];
                                      }
                                    }
                                  }
                                  const todayString = new Date().toISOString().split('T')[0];
                                  const isDefaultDate = entry.editedEffectiveDate === todayString;
                                  const displayDate = (!isDefaultDate && entry.editedEffectiveDate) 
                                    ? entry.editedEffectiveDate 
                                    : (extractedDate || cutoverDate || todayString);
                                  return (
                                    <input
                                      type="date"
                                      value={displayDate}
                                      onChange={(e) => {
                                        const newDate = e.target.value;
                                        setEditedResults(prev => {
                                          const newResults = { ...prev };
                                          if (!newResults[result.productId]) {
                                            newResults[result.productId] = { ...result };
                                          }
                                          if (!newResults[result.productId].extractedEntries) {
                                            newResults[result.productId].extractedEntries = [...result.extractedEntries];
                                          }
                                          newResults[result.productId].extractedEntries[idx] = {
                                            ...newResults[result.productId].extractedEntries[idx],
                                            editedEffectiveDate: newDate,
                                          };
                                          return newResults;
                                        });
                                      }}
                                      className={`w-full px-2 py-1 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary ${
                                        isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
                                      }`}
                                    />
                                  );
                                })()}
                              </td>
                              
                              {/* Source column */}
                              <td className="px-4 py-3 text-sm text-gray-600">
                                {entry.originalLine || `$${entry.amount.toFixed(2)}`}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  /* Manual Input */
                  <div className="space-y-3 border border-red-200 bg-red-50 rounded-lg p-4">
                    <div className="flex items-start gap-2">
                      <span className="text-red-600">⚠️</span>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-red-800 mb-2">No cost extracted - manual input required</p>
                        <div className="autocomplete-container relative mb-3">
                          <label className="block text-xs text-gray-700 mb-1">Supplier Name *</label>
                          <input
                            type="text"
                            value={edited.selectedSupplierName ?? ''}
                            onChange={(e) => {
                              const newValue = e.target.value;
                              setEditedResults(prev => {
                                const newResults = { ...prev };
                                if (!newResults[result.productId]) {
                                  newResults[result.productId] = { ...result };
                                }
                                newResults[result.productId].selectedSupplierName = newValue;
                                return newResults;
                              });
                              const localSuggestions = getSupplierSuggestions(newValue, '');
                              if (localSuggestions.length > 0) {
                                setOpenAutocomplete(prev => ({ ...prev, [result.productId]: true }));
                                setSupplierSuggestions(prev => ({ ...prev, [result.productId]: localSuggestions }));
                              } else if (newValue.length > 1) {
                                fetch(`/admin/inventory/cutover/suppliers/suggest?q=${encodeURIComponent(newValue)}`)
                                  .then(res => res.json())
                                  .then(data => {
                                    if (data.success) {
                                      setOpenAutocomplete(prev => ({ ...prev, [result.productId]: true }));
                                      setSupplierSuggestions(prev => ({ ...prev, [result.productId]: data.suppliers }));
                                    }
                                  });
                              } else {
                                setOpenAutocomplete(prev => {
                                  const newState = { ...prev };
                                  delete newState[result.productId];
                                  return newState;
                                });
                              }
                            }}
                            onBlur={() => {
                              setTimeout(() => {
                                if (!dropdownSelectionRef.current[result.productId]) {
                                  setOpenAutocomplete(prev => {
                                    const newState = { ...prev };
                                    delete newState[result.productId];
                                    return newState;
                                  });
                                }
                                dropdownSelectionRef.current[result.productId] = false;
                              }, 200);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                            placeholder="Enter supplier name"
                          />
                          {openAutocomplete[result.productId] && supplierSuggestions[result.productId] && supplierSuggestions[result.productId].length > 0 && (
                            <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-auto">
                              {supplierSuggestions[result.productId].map((suggestion, sIdx) => (
                                <div
                                  key={sIdx}
                                  className="px-3 py-2 hover:bg-gray-100 cursor-pointer text-sm"
                                  onMouseDown={() => {
                                    dropdownSelectionRef.current[result.productId] = true;
                                    setEditedResults(prev => {
                                      const newResults = { ...prev };
                                      if (!newResults[result.productId]) {
                                        newResults[result.productId] = { ...result };
                                      }
                                      newResults[result.productId].selectedSupplierName = suggestion.name;
                                      newResults[result.productId].selectedSupplierId = suggestion.id;
                                      return newResults;
                                    });
                                    setOpenAutocomplete(prev => {
                                      const newState = { ...prev };
                                      delete newState[result.productId];
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
                        <div>
                          <label className="block text-xs text-gray-700 mb-1">Cost *</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={edited.selectedCost || ''}
                            onChange={(e) => {
                              const newCost = parseFloat(e.target.value) || 0;
                              if (newCost < 0) {
                                setError('Cost cannot be negative');
                                return;
                              }
                              if (newCost === 0) {
                                if (!window.confirm('Cost is zero. Are you sure?')) {
                                  return;
                                }
                              }
                              setEditedResults(prev => {
                                const newResults = { ...prev };
                                if (!newResults[result.productId]) {
                                  newResults[result.productId] = { ...result };
                                }
                                newResults[result.productId].selectedCost = newCost;
                                return newResults;
                              });
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                            placeholder="Enter cost"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Right Column: Product Review */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-gray-900 uppercase tracking-wide">Product Review</h3>
                <div>
                  <h4 className="font-semibold text-gray-900 text-base">{result.productName}</h4>
                  {result.originalDescription && result.originalDescription !== result.productName && (
                    <p className="text-sm text-gray-600 mt-1">{result.originalDescription}</p>
                  )}
                  <div className="mt-4 bg-gray-100 rounded-lg p-8 flex items-center justify-center min-h-[200px]">
                    {result.imageUrl ? (
                      <img src={result.imageUrl} alt={result.productName} className="max-w-full max-h-48 object-contain" />
                    ) : (
                      <div className="text-gray-400 text-sm">No image available</div>
                    )}
                  </div>
                </div>
                <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                  <h5 className="text-sm font-semibold text-gray-700 mb-3 uppercase">Currently Selected</h5>
                  <div className="space-y-2">
                    <div>
                      <span className="text-xs text-gray-600">Supplier:</span>
                      <span className="ml-2 font-medium text-gray-900">{displaySupplier || 'Not selected'}</span>
                    </div>
                    <div>
                      <span className="text-xs text-gray-600">Cost:</span>
                      <span className="ml-2 font-bold text-lg text-gray-900">
                        ${displayCost !== null && displayCost !== undefined ? displayCost.toFixed(2) : '0.00'}
                      </span>
                    </div>
                  </div>
                </div>
                {hasExtraction && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Preferred Supplier Override</label>
                    <select
                      value={edited.selectedSupplierName || displaySupplier || ''}
                      onChange={(e) => {
                        const selectedName = e.target.value;
                        const selectedSupplier = allSuppliers.find(s => s.name === selectedName);
                        setEditedResults(prev => {
                          const newResults = { ...prev };
                          if (!newResults[result.productId]) {
                            newResults[result.productId] = { ...result };
                          }
                          newResults[result.productId].selectedSupplierName = selectedName;
                          newResults[result.productId].selectedSupplierId = selectedSupplier?.id || null;
                          return newResults;
                        });
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      <option value="">Select preferred supplier</option>
                      {allSuppliers.filter(s => s.isActive).map(supplier => (
                        <option key={supplier.id} value={supplier.name}>
                          {supplier.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="flex gap-3 pt-4">
                  <button
                    onClick={() => onApprove(result)}
                    className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md font-medium"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => onDiscard(result.productId)}
                    className="flex-1 px-4 py-2 border border-red-600 text-red-600 hover:bg-red-50 rounded-md font-medium"
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>
          </div>
          
          {/* Navigation */}
          {groupedResults.extracting.length > 0 && (
            <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setCurrentExtractingIndex(prev => Math.max(0, prev - 1))}
                  disabled={currentExtractingIndex === 0}
                  className={`px-4 py-2 rounded-md font-medium text-sm ${
                    currentExtractingIndex === 0
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  ← Previous
                </button>
                <span className="text-sm font-medium text-gray-700">
                  Item {currentExtractingIndex + 1} of {groupedResults.extracting.length}
                </span>
                <button
                  onClick={() => setCurrentExtractingIndex(prev => Math.min(groupedResults.extracting.length - 1, prev + 1))}
                  disabled={currentExtractingIndex >= groupedResults.extracting.length - 1}
                  className={`px-4 py-2 rounded-md font-medium text-sm ${
                    currentExtractingIndex >= groupedResults.extracting.length - 1
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-8 text-gray-500">
          No items need action
        </div>
      )}
    </div>
  );
};
