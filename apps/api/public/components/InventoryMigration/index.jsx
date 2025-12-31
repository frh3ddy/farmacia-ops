// Main InventoryMigration Component - Orchestrates state machine and phase components
const { useEffect } = React;

const InventoryMigration = () => {
  // Use custom hooks for state management
  const state = useInventoryMigrationState();
  const supplierMatching = useSupplierMatching(
    state.allSuppliers,
    state.supplierNameMappings,
    state.setEditedResults,
    state.setSupplierNameMappings,
    state.setOpenAutocomplete
  );
  const sessionManagement = useExtractionSession(state.setExistingSessions);
  
  // Merge session management state
  const showSessionSelector = sessionManagement.showSessionSelector;
  const setShowSessionSelector = sessionManagement.setShowSessionSelector;
  const selectedSessionToResume = sessionManagement.selectedSessionToResume;
  const setSelectedSessionToResume = sessionManagement.setSelectedSessionToResume;

  // Close autocomplete when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!event.target.closest('.autocomplete-container')) {
        state.setOpenAutocomplete({});
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch initial data
  useEffect(() => {
    fetchLocations(state.setLocations, state.setError);
    fetchAllSuppliers(state.setAllSuppliers);
  }, []);

  // Fetch CostApproval data for approved items
  useEffect(() => {
    const fetchCostApprovals = async () => {
      const approvedItems = state.extractionResults.filter(r => r.migrationStatus === 'APPROVED');
      if (approvedItems.length === 0) {
        state.setCostApprovals({});
        return;
      }
      
      const cutoverId = state.currentCutoverId || state.extractionResult?.cutoverId || state.extractionSessionId;
      if (!cutoverId || !state.extractionSessionId) {
        state.setCostApprovals({});
        return;
      }
      
      const productIds = approvedItems.map(r => r.productId);
      
      try {
        const response = await fetch(`/admin/inventory/cutover/extraction-session/${state.extractionSessionId}`);
        if (!response.ok) {
          state.setCostApprovals({});
          return;
        }
        
        const sessionData = await response.json();
        if (sessionData.success && sessionData.session) {
          if (sessionData.session.costApprovals && Array.isArray(sessionData.session.costApprovals)) {
            const approvalsMap = {};
            sessionData.session.costApprovals
              .filter(approval => approval && productIds.includes(approval.productId))
              .forEach(approval => {
                approvalsMap[approval.productId] = approval;
              });
            state.setCostApprovals(approvalsMap);
          } else {
            state.setCostApprovals({});
          }
        } else {
          state.setCostApprovals({});
        }
      } catch (err) {
        console.error('Failed to fetch cost approvals:', err);
      }
    };
    
    if (state.extractionTab === 'approved' && state.extractionResults.length > 0) {
      fetchCostApprovals();
    }
  }, [state.extractionResults, state.extractionTab, state.currentCutoverId, state.extractionResult?.cutoverId, state.extractionSessionId]);

  // Handler: Resume an existing session
  const handleResumeSession = async (sessionId) => {
    state.setExtractionSessionId(sessionId);
    setShowSessionSelector(false);
    setSelectedSessionToResume(sessionId);
    state.setLoading(true);
    state.setError(null);
    
    try {
      const sessionResponse = await fetch(`/admin/inventory/cutover/extraction-session/${sessionId}`);
      const sessionData = await sessionResponse.json();
      if (sessionData.success) {
        if (sessionData.session.locationIds && sessionData.session.locationIds.length > 0) {
          state.setSelectedLocationId(sessionData.session.locationIds[0]);
        }
        if (sessionData.session.batchSize) {
          if (state.batchSize === 50 || state.batchSize === sessionData.session.batchSize) {
            state.setBatchSize(sessionData.session.batchSize);
          }
        }
        if (sessionData.session.learnedSupplierInitials) {
          state.setSupplierInitialsMap(sessionData.session.learnedSupplierInitials);
        }
        const batches = sessionData.session.batches || [];
        const latestBatch = batches.length > 0 ? batches[batches.length - 1] : null;
        if (latestBatch && latestBatch.status === 'EXTRACTED') {
          await handleExtractCosts(true);
        } else {
          await handleExtractCosts(true);
        }
      } else {
        state.setError('Failed to load session: ' + (sessionData.message || 'Unknown error'));
        state.setLoading(false);
      }
    } catch (err) {
      state.setError('Failed to resume session: ' + err.message);
      state.setLoading(false);
    }
  };

  // Handler: Continue extraction
  const handleExtractCosts = async (continueExtraction = false) => {
    if (!continueExtraction && !state.selectedLocationId) {
      state.setError('Please select a location');
      return;
    }

    state.setLoading(true);
    state.setError(null);
    if (!continueExtraction) {
      state.setExtractionResults([]);
      state.setExtractionSessionId(null);
    }

    try {
      const response = await fetch('/admin/inventory/cutover/extract-costs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationIds: state.selectedLocationId ? [state.selectedLocationId] : [],
          costBasis: state.costBasis,
          batchSize: continueExtraction ? null : state.batchSize,
          newBatchSize: continueExtraction ? (state.batchSize && state.batchSize > 0 ? state.batchSize : null) : null,
          extractionSessionId: continueExtraction ? state.extractionSessionId : null,
        }),
      });

      const data = await response.json();
      if (response.ok && data.success) {
        const result = data.result;
        
        // Match supplier initials to full supplier names
        if (result.extractionResults) {
          result.extractionResults = result.extractionResults.map(productResult => {
            if (productResult.extractedEntries) {
              const entriesWithMatches = productResult.extractedEntries.map((entry, idx) => {
                const originalSupplier = entry.supplier;
                let matchedSupplierName = null;
                let matchedSupplierId = null;
                const isUnknownOrGeneral = !originalSupplier || originalSupplier === 'Unknown' || originalSupplier === 'General';
                
                if (!isUnknownOrGeneral && originalSupplier) {
                  const supplierInitial = originalSupplier.trim().toLowerCase();
                  const matchedByInitial = state.allSuppliers.find(s => {
                    const initials = Array.isArray(s.initials) ? s.initials : (s.initials ? [s.initials] : []);
                    return initials.some(init => init.toLowerCase() === supplierInitial.toLowerCase()) && s.isActive;
                  });
                  
                  if (matchedByInitial) {
                    matchedSupplierName = matchedByInitial.name;
                    matchedSupplierId = matchedByInitial.id;
                  } else {
                    const matchedByName = state.allSuppliers.find(s => 
                      s.name.toLowerCase() === originalSupplier.toLowerCase() && s.isActive
                    );
                    if (matchedByName) {
                      matchedSupplierName = matchedByName.name;
                      matchedSupplierId = matchedByName.id;
                    }
                  }
                  
                  if (!matchedSupplierName && state.supplierNameMappings.length > 0) {
                    const mapping = state.supplierNameMappings.find(m => m.supplierOriginal === originalSupplier);
                    if (mapping) {
                      matchedSupplierName = mapping.new;
                      const mappedSupplier = state.allSuppliers.find(s => s.name === mapping.new && s.isActive);
                      if (mappedSupplier) {
                        matchedSupplierId = mappedSupplier.id;
                      }
                    }
                  }
                }
                
                return { entry, idx, matchedSupplierName, matchedSupplierId };
              });
              
              productResult.extractedEntries = productResult.extractedEntries.map((entry, idx) => {
                const matchInfo = entriesWithMatches[idx];
                if (matchInfo.matchedSupplierName) {
                  return {
                    ...entry,
                    supplier: matchInfo.entry.supplier,
                    editedSupplierName: matchInfo.matchedSupplierName,
                    supplierId: matchInfo.matchedSupplierId,
                    isSelected: entry.isSelected !== undefined ? entry.isSelected : (idx === productResult.extractedEntries.length - 1),
                  };
                }
                return {
                  ...entry,
                  isSelected: entry.isSelected !== undefined ? entry.isSelected : (idx === productResult.extractedEntries.length - 1),
                };
              });
              
              const selectedEntry = productResult.extractedEntries.find(e => e.isSelected) 
                || productResult.extractedEntries[productResult.extractedEntries.length - 1];
              
              if (selectedEntry) {
                productResult.selectedSupplierName = selectedEntry.editedSupplierName || selectedEntry.supplier;
                productResult.selectedSupplierId = selectedEntry.supplierId;
                productResult.selectedCost = selectedEntry.editedCost !== null && selectedEntry.editedCost !== undefined 
                  ? selectedEntry.editedCost 
                  : selectedEntry.amount;
              }
            }
            return productResult;
          });
        }
        
        if (continueExtraction && result.extractionResults) {
          const currentBatchProductIds = new Set(result.extractionResults.map(r => r.productId));
          state.setEditedResults(prev => {
            const filtered = {};
            currentBatchProductIds.forEach(productId => {
              if (prev[productId]) {
                filtered[productId] = prev[productId];
              }
            });
            return filtered;
          });
        } else if (!continueExtraction) {
          state.setEditedResults({});
        }
        
        state.setExtractionResult(result);
        if (result.extractionSessionId) {
          state.setExtractionSessionId(result.extractionSessionId);
          try {
            const sessionResponse = await fetch(`/admin/inventory/cutover/extraction-session/${result.extractionSessionId}`);
            const sessionData = await sessionResponse.json();
            if (sessionData.success && sessionData.session.batches && sessionData.session.batches.length > 0) {
              const latestBatch = sessionData.session.batches[sessionData.session.batches.length - 1];
              state.setCurrentBatchId(latestBatch.id);
              if (sessionData.session.learnedSupplierInitials) {
                state.setSupplierInitialsMap(sessionData.session.learnedSupplierInitials);
              }
            }
          } catch (err) {
            console.warn('Failed to fetch session details:', err);
          }
        }
        
        state.setExtractionApproved(false);
        state.setManualInputApproved(false);
        state.setExtractionResults(result.extractionResults || []);
        state.setState('extracting');
      } else {
        state.setError(data.message || 'Failed to extract costs');
      }
    } catch (err) {
      state.setError(err.message || 'Failed to extract costs');
    } finally {
      state.setLoading(false);
    }
  };

  // Handler: Start extraction session
  const handleStartExtraction = async () => {
    if (!state.selectedLocationId) {
      state.setError('Please select a location');
      return;
    }
    if (new Date(state.cutoverDate) > new Date()) {
      state.setError('Cutover date cannot be in the future');
      return;
    }
    if (state.batchSize < 10 || state.batchSize > 500) {
      state.setError('Batch size must be between 10 and 500');
      return;
    }

    const sessions = await sessionManagement.fetchExistingSessions(state.selectedLocationId);
    if (sessions.length > 0) {
      setShowSessionSelector(true);
      return;
    }

    await handleExtractCosts(false);
  };

  // Handler: Start new extraction
  const handleStartNewExtraction = async () => {
    state.setLoading(true);
    state.setError(null);
    try {
      const response = await fetch('/admin/inventory/cutover/extract-costs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationIds: [state.selectedLocationId],
          costBasis: state.costBasis,
          batchSize: state.batchSize,
        }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        await handleExtractCosts(false);
      } else {
        state.setError(data.message || 'Failed to start extraction');
        state.setLoading(false);
      }
    } catch (err) {
      state.setError(err.message || 'Failed to start extraction');
      state.setLoading(false);
    }
  };

  // Handler: Discard item
  const handleDiscardItem = async (productId) => {
    const cutoverId = state.currentCutoverId || state.extractionResult?.cutoverId || state.extractionSessionId;
    if (!cutoverId) {
      state.setError('Missing cutover ID. Please start extraction first.');
      return;
    }
    try {
      const response = await fetch('/admin/inventory/cutover/discard-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutoverId, productId }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        state.setExtractionResults(prev => prev.map(r => 
          r.productId === productId ? { ...r, migrationStatus: 'SKIPPED' } : r
        ));
        state.setCurrentExtractingIndex(prev => {
          const currentExtractingCount = state.extractionResults.filter(r => 
            !r.migrationStatus || r.migrationStatus === 'PENDING'
          ).length;
          if (prev < currentExtractingCount - 1) {
            return prev;
          } else {
            return Math.max(0, prev - 1);
          }
        });
      } else {
        state.setError(data.message || 'Failed to discard item');
      }
    } catch (err) {
      state.setError(err.message || 'Failed to discard item');
    }
  };

  // Handler: Restore item
  const handleRestoreItem = async (productId) => {
    const cutoverId = state.currentCutoverId || state.extractionResult?.cutoverId || state.extractionSessionId;
    if (!cutoverId) {
      state.setError('Missing cutover ID. Please start extraction first.');
      return;
    }
    try {
      const response = await fetch('/admin/inventory/cutover/restore-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutoverId, productId }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        state.setExtractionResults(prev => prev.map(r => 
          r.productId === productId ? { ...r, migrationStatus: 'PENDING' } : r
        ));
      } else {
        state.setError(data.message || 'Failed to restore item');
      }
    } catch (err) {
      state.setError(err.message || 'Failed to restore item');
    }
  };

  // Handler: Continue to next batch
  const handleContinueBatch = async () => {
    if (!state.extractionSessionId) {
      state.setError('Missing session ID. Please resume the session first.');
      state.setBatchComplete(false);
      return;
    }
    
    state.setLoading(true);
    state.setError(null);
    state.setBatchComplete(false);
    
    try {
      const response = await fetch('/admin/inventory/cutover/extract-costs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationIds: [state.selectedLocationId],
          costBasis: state.costBasis,
          batchSize: null,
          newBatchSize: state.batchSize && state.batchSize > 0 ? state.batchSize : null,
          extractionSessionId: state.extractionSessionId,
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Failed to continue batch' }));
        throw new Error(errorData.message || `HTTP ${response.status}: Failed to continue batch`);
      }
      
      const data = await response.json();
      if (data.success) {
        const result = data.result;
        
        // Match supplier initials (same logic as handleExtractCosts)
        if (result.extractionResults) {
          result.extractionResults = result.extractionResults.map(productResult => {
            if (productResult.extractedEntries) {
              productResult.extractedEntries = productResult.extractedEntries.map((entry, idx) => {
                const originalSupplier = entry.supplier;
                let matchedSupplierName = null;
                let matchedSupplierId = null;
                let matchedByInitial = false;
                const isUnknownOrGeneral = !originalSupplier || originalSupplier === 'Unknown' || originalSupplier === 'General';
                
                if (!isUnknownOrGeneral && originalSupplier) {
                  const supplierInitial = originalSupplier.trim().toLowerCase();
                  const matchedByInitialResult = state.allSuppliers.find(s => {
                    const initials = Array.isArray(s.initials) ? s.initials : (s.initials ? [s.initials] : []);
                    return initials.some(init => init.toLowerCase() === supplierInitial) && s.isActive;
                  });
                  
                  if (matchedByInitialResult) {
                    matchedSupplierName = matchedByInitialResult.name;
                    matchedSupplierId = matchedByInitialResult.id;
                    matchedByInitial = true;
                  } else {
                    const matchedByName = state.allSuppliers.find(s => 
                      s.name.toLowerCase() === originalSupplier.toLowerCase() && s.isActive
                    );
                    if (matchedByName) {
                      matchedSupplierName = matchedByName.name;
                      matchedSupplierId = matchedByName.id;
                    }
                  }
                }
                
                return {
                  ...entry,
                  supplier: originalSupplier,
                  editedSupplierName: matchedSupplierName || originalSupplier,
                  supplierId: matchedSupplierId,
                  isSelected: matchedSupplierName ? true : (idx === productResult.extractedEntries.length - 1),
                  matchedByInitial: matchedByInitial,
                };
              });
              
              const matchedEntry = productResult.extractedEntries.find(e => e.isSelected && e.editedSupplierName && e.supplierId) ||
                productResult.extractedEntries[productResult.extractedEntries.length - 1];
              if (matchedEntry) {
                productResult.selectedCost = matchedEntry.editedCost !== null && matchedEntry.editedCost !== undefined 
                  ? matchedEntry.editedCost 
                  : matchedEntry.amount;
                productResult.selectedSupplierName = matchedEntry.editedSupplierName || matchedEntry.supplier;
                productResult.selectedSupplierId = matchedEntry.supplierId;
              }
            }
            return productResult;
          });
        }
        
        const newBatchProductIds = new Set((result.extractionResults || []).map(r => r.productId));
        state.setEditedResults(prev => {
          const filtered = {};
          newBatchProductIds.forEach(productId => {
            if (prev[productId]) {
              filtered[productId] = prev[productId];
            }
          });
          return filtered;
        });
        
        state.setExtractionResult(result);
        if (result.extractionSessionId) {
          state.setExtractionSessionId(result.extractionSessionId);
          try {
            const sessionResponse = await fetch(`/admin/inventory/cutover/extraction-session/${result.extractionSessionId}`);
            const sessionData = await sessionResponse.json();
            if (sessionData.success && sessionData.session.batches && sessionData.session.batches.length > 0) {
              const latestBatch = sessionData.session.batches[sessionData.session.batches.length - 1];
              state.setCurrentBatchId(latestBatch.id);
              if (sessionData.session.learnedSupplierInitials) {
                state.setSupplierInitialsMap(sessionData.session.learnedSupplierInitials);
              }
            }
          } catch (err) {
            console.warn('Failed to fetch session details:', err);
          }
        }
        
        state.setExtractionApproved(false);
        state.setManualInputApproved(false);
        
        let newResults = result.extractionResults || [];
        newResults = newResults.map(r => {
          if (!r.isAlreadyApproved) {
            if (r.migrationStatus && r.migrationStatus !== 'PENDING') {
              return { ...r, migrationStatus: 'PENDING' };
            }
            if (!r.migrationStatus) {
              return { ...r, migrationStatus: 'PENDING' };
            }
          }
          return r;
        });
        
        state.setBatchComplete(false);
        state.setExtractionResults(newResults);
        
        if (result.isComplete || newResults.length === 0) {
          state.setState('reviewing');
        } else {
          state.setState('extracting');
        }
      } else {
        const errorMsg = data.message || 'Failed to continue batch';
        state.setError(errorMsg);
        state.setBatchComplete(false);
      }
    } catch (err) {
      const errorMsg = err.message || 'Failed to continue batch';
      state.setError(errorMsg);
      state.setBatchComplete(false);
    } finally {
      state.setLoading(false);
    }
  };

  // Handler: Approve item
  const handleApproveItem = async (result) => {
    const cutoverId = state.currentCutoverId || state.extractionResult?.cutoverId || state.extractionSessionId;
    if (!cutoverId) {
      state.setError('Missing cutover ID. Please start extraction first.');
      return;
    }

    const edited = state.editedResults[result.productId] || result;
    const hasExtraction = edited.extractedEntries && edited.extractedEntries.length > 0;
    const selectedEntry = edited.extractedEntries?.find(e => e.isSelected) || 
      (edited.extractedEntries?.length > 0 ? edited.extractedEntries[edited.extractedEntries.length - 1] : null);
    
    const cost = edited.selectedCost !== null && edited.selectedCost !== undefined 
      ? edited.selectedCost 
      : (selectedEntry ? (selectedEntry.editedCost !== null && selectedEntry.editedCost !== undefined ? selectedEntry.editedCost : selectedEntry.amount) : null);
    
    if (cost === null || cost === undefined || cost <= 0) {
      state.setError('Please enter a valid cost');
      return;
    }
    
    if (!hasExtraction && !edited.selectedSupplierName) {
      state.setError('Please enter a supplier name');
      return;
    }
    
    const supplierName = edited.selectedSupplierName || (selectedEntry ? (selectedEntry.editedSupplierName || selectedEntry.supplier) : null) || 'General';
    const supplierId = edited.selectedSupplierId || selectedEntry?.supplierId || null;
    
    // Collect all initials that need to be added
    const initialsToAdd = [];
    if (hasExtraction && edited.extractedEntries && result.extractedEntries) {
      const originalEntries = result.extractedEntries;
      for (let i = 0; i < edited.extractedEntries.length; i++) {
        const editedEntry = edited.extractedEntries[i];
        const originalEntry = originalEntries[i] || editedEntry;
        const originalSupplier = originalEntry.supplier;
        const finalSupplierName = editedEntry.editedSupplierName || editedEntry.supplier;
        
        if (!originalSupplier || !finalSupplierName || 
            originalSupplier === finalSupplierName ||
            originalSupplier.trim().length === 0 ||
            finalSupplierName.trim().length === 0) {
          continue;
        }
        
        if (originalSupplier.trim().length > 0 && 
            finalSupplierName.trim().length > originalSupplier.trim().length) {
          const supplier = state.allSuppliers.find(s => s.name === finalSupplierName);
          const dbInitials = supplier?.initials || [];
          const pendingInitials = state.supplierInitialsMap[finalSupplierName] || [];
          const allInitials = [...dbInitials, ...pendingInitials];
          const trimmedInitial = originalSupplier.trim();
          
          const initialExists = allInitials.some(init => 
            init.trim().toLowerCase() === trimmedInitial.toLowerCase()
          );
          
          if (!initialExists) {
            const alreadyInList = initialsToAdd.some(
              item => item.initial.toLowerCase() === trimmedInitial.toLowerCase() && item.supplierName === finalSupplierName
            );
            if (!alreadyInList) {
              initialsToAdd.push({
                initial: trimmedInitial,
                supplierName: finalSupplierName
              });
            }
          }
        }
      }
    }
    
    // Show single prompt for all initials
    if (initialsToAdd.length > 0) {
      const initialsList = initialsToAdd.map(item => `"${item.initial}" → "${item.supplierName}"`).join('\n');
      const shouldAdd = window.confirm(
        `Add the following supplier initials?\n\n${initialsList}\n\nThis will help match similar suppliers in future extractions.`
      );
      
      if (!shouldAdd) {
        return;
      }
      
      state.setSupplierInitialsMap(prev => {
        const newMap = { ...prev };
        for (const item of initialsToAdd) {
          if (!newMap[item.supplierName]) {
            newMap[item.supplierName] = [];
          }
          if (!newMap[item.supplierName].includes(item.initial)) {
            newMap[item.supplierName] = [...newMap[item.supplierName], item.initial];
          }
        }
        return newMap;
      });
    }
    
    let source = 'DESCRIPTION';
    if (hasExtraction) {
      if (selectedEntry && selectedEntry.editedCost !== null && selectedEntry.editedCost !== undefined) {
        source = 'MANUAL_OVERRIDE';
      } else {
        source = 'EXTRACTED_SELECTED';
      }
    } else {
      source = 'MANUAL_INPUT';
    }
    
    try {
      const entriesToSend = hasExtraction && edited.extractedEntries
        ? edited.extractedEntries.map(entry => ({
            supplier: entry.supplier,
            amount: entry.amount,
            supplierId: entry.supplierId || null,
            editedSupplierName: entry.editedSupplierName || null,
            editedCost: entry.editedCost !== null && entry.editedCost !== undefined ? entry.editedCost : null,
            editedEffectiveDate: entry.editedEffectiveDate || null,
            isSelected: entry.isSelected || false,
          }))
        : [];
      
      const response = await fetch('/admin/inventory/cutover/approve-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cutoverId: cutoverId,
          productId: result.productId,
          cost: cost,
          source: source,
          notes: supplierName ? `Supplier: ${supplierName}` : null,
          extractedEntries: entriesToSend,
          selectedSupplierId: supplierId,
          selectedSupplierName: supplierName,
        }),
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to approve item');
      }
      
      // Save supplier initials if any were learned
      if (initialsToAdd.length > 0) {
        try {
          for (const item of initialsToAdd) {
            const initialResponse = await fetch('/admin/inventory/cutover/suppliers/add-initial', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ supplierName: item.supplierName, initial: item.initial }),
            });
            if (!initialResponse.ok) {
              const errorData = await initialResponse.json();
              console.error(`Failed to save initial "${item.initial}" for "${item.supplierName}":`, errorData);
            }
          }
          state.setSupplierInitialsMap(prev => {
            const newMap = { ...prev };
            for (const item of initialsToAdd) {
              if (newMap[item.supplierName]) {
                newMap[item.supplierName] = newMap[item.supplierName].filter(
                  init => init.toLowerCase() !== item.initial.toLowerCase()
                );
                if (newMap[item.supplierName].length === 0) {
                  delete newMap[item.supplierName];
                }
              }
            }
            return newMap;
          });
          const updatedSuppliers = await fetchAllSuppliers(state.setAllSuppliers);
          
          // Re-match suppliers for all pending extraction results
          if (updatedSuppliers.length > 0) {
            state.setExtractionResults(prevResults => {
              return prevResults.map(productResult => {
                if (productResult.migrationStatus === 'APPROVED' || productResult.migrationStatus === 'SKIPPED') {
                  return productResult;
                }
                
                if (productResult.extractedEntries) {
                  const entriesWithMatches = productResult.extractedEntries.map((entry, idx) => {
                    const originalSupplier = entry.supplier;
                    let matchedSupplierName = null;
                    let matchedSupplierId = null;
                    let matchedByInitial = false;
                    const isUnknownOrGeneral = !originalSupplier || originalSupplier === 'Unknown' || originalSupplier === 'General';
                    
                    if (!isUnknownOrGeneral && originalSupplier) {
                      const supplierInitial = originalSupplier.trim().toLowerCase();
                      const matchedByInitialResult = updatedSuppliers.find(s => {
                        const initials = Array.isArray(s.initials) ? s.initials : (s.initials ? [s.initials] : []);
                        return initials.some(init => init.toLowerCase() === supplierInitial) && s.isActive;
                      });
                      
                      if (matchedByInitialResult) {
                        matchedSupplierName = matchedByInitialResult.name;
                        matchedSupplierId = matchedByInitialResult.id;
                        matchedByInitial = true;
                      } else {
                        const matchedByName = updatedSuppliers.find(s => 
                          s.name.toLowerCase() === originalSupplier.toLowerCase() && s.isActive
                        );
                        if (matchedByName) {
                          matchedSupplierName = matchedByName.name;
                          matchedSupplierId = matchedByName.id;
                        }
                      }
                    }
                    
                    return {
                      entry,
                      idx,
                      matchedSupplierName,
                      matchedSupplierId,
                      matchedByInitial,
                    };
                  });
                  
                  const updatedEntries = productResult.extractedEntries.map((entry, idx) => {
                    const matchInfo = entriesWithMatches[idx];
                    if (matchInfo.matchedSupplierName) {
                      return {
                        ...entry,
                        supplier: matchInfo.entry.supplier,
                        editedSupplierName: matchInfo.matchedSupplierName,
                        supplierId: matchInfo.matchedSupplierId,
                        isSelected: entry.isSelected !== undefined ? entry.isSelected : (idx === productResult.extractedEntries.length - 1),
                        matchedByInitial: matchInfo.matchedByInitial,
                      };
                    }
                    return {
                      ...entry,
                      isSelected: entry.isSelected !== undefined ? entry.isSelected : (idx === productResult.extractedEntries.length - 1),
                    };
                  });
                  
                  const selectedEntry = updatedEntries.find(e => e.isSelected) 
                    || updatedEntries[updatedEntries.length - 1];
                  
                  if (selectedEntry) {
                    return {
                      ...productResult,
                      extractedEntries: updatedEntries,
                      selectedSupplierName: selectedEntry.editedSupplierName || selectedEntry.supplier,
                      selectedSupplierId: selectedEntry.supplierId,
                      selectedCost: selectedEntry.editedCost !== null && selectedEntry.editedCost !== undefined 
                        ? selectedEntry.editedCost 
                        : selectedEntry.amount,
                    };
                  }
                  
                  return {
                    ...productResult,
                    extractedEntries: updatedEntries,
                  };
                }
                return productResult;
              });
            });
          }
        } catch (initialsErr) {
          console.warn('Failed to save some supplier initials:', initialsErr);
        }
      }
      
      state.setExtractionResults(prev => prev.map(r => 
        r.productId === result.productId ? { 
          ...r, 
          migrationStatus: 'APPROVED',
          selectedCost: cost,
          selectedSupplierName: supplierName,
          selectedSupplierId: supplierId,
        } : r
      ));
      
      state.setCurrentExtractingIndex(prev => {
        const currentExtractingCount = state.extractionResults.filter(r => 
          !r.migrationStatus || r.migrationStatus === 'PENDING'
        ).length;
        if (prev < currentExtractingCount - 1) {
          return prev;
        } else {
          return Math.max(0, prev - 1);
        }
      });
    } catch (err) {
      state.setError(err.message || 'Failed to approve item');
    }
  };

  // Handler: Start migration
  const handleStartMigration = async () => {
    const pendingItems = state.extractionResults.filter(r => 
      !r.migrationStatus || r.migrationStatus === 'PENDING'
    );
    if (pendingItems.length > 0) {
      if (!window.confirm(`You have ${pendingItems.length} pending items. Discard them or review?`)) {
        return;
      }
    }
    state.setLoading(true);
    state.setError(null);
    state.setState('migrating');
    try {
      const response = await fetch('/admin/inventory/cutover/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cutoverDate: state.cutoverDate + 'T00:00:00Z',
          locationIds: [state.selectedLocationId],
          costBasis: state.costBasis,
          ownerApproved: true,
          approvalId: state.currentCutoverId,
          batchSize: state.batchSize,
        }),
      });
      const data = await response.json();
      if (data.success) {
        state.setMigrationResult(data.result);
        if (data.result.isComplete) {
          state.setReportData(data.result);
          state.setState('reporting');
        } else {
          handleContinueMigration();
        }
      } else {
        state.setError(data.message || 'Migration failed');
        state.setState('extracting');
      }
    } catch (err) {
      state.setError(err.message || 'Migration failed');
      state.setState('extracting');
    } finally {
      state.setLoading(false);
    }
  };

  // Handler: Continue migration batches
  const handleContinueMigration = async () => {
    try {
      const response = await fetch('/admin/inventory/cutover/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutoverId: state.currentCutoverId }),
      });
      const data = await response.json();
      if (data.success) {
        state.setMigrationResult(data.result);
        if (data.result.isComplete) {
          state.setReportData(data.result);
          state.setState('reporting');
        }
      }
    } catch (err) {
      state.setError(err.message || 'Failed to continue migration');
    }
  };

  // Group extraction results by status
  const groupedResults = {
    extracting: state.extractionResults.filter(r => 
      r.migrationStatus !== 'SKIPPED' && r.migrationStatus !== 'APPROVED'
    ),
    approved: state.extractionResults.filter(r => r.migrationStatus === 'APPROVED'),
    discarded: state.extractionResults.filter(r => r.migrationStatus === 'SKIPPED'),
  };

  // Render based on state machine
  if (state.state === 'configuring') {
    return (
      <ConfigurationPhase
        selectedLocationId={state.selectedLocationId}
        setSelectedLocationId={state.setSelectedLocationId}
        cutoverDate={state.cutoverDate}
        setCutoverDate={state.setCutoverDate}
        costBasis={state.costBasis}
        setCostBasis={state.setCostBasis}
        batchSize={state.batchSize}
        setBatchSize={state.setBatchSize}
        locations={state.locations}
        loading={state.loading}
        error={state.error}
        onStartExtraction={handleStartExtraction}
        showSessionSelector={showSessionSelector}
        existingSessions={state.existingSessions}
        onResumeSession={handleResumeSession}
        onStartNew={handleStartNewExtraction}
        onCloseSessionSelector={() => setShowSessionSelector(false)}
      />
    );
  }

  if (state.state === 'extracting' || state.state === 'reviewing') {
    return (
      <ExtractionPhase
        extractionResults={state.extractionResults}
        setExtractionResults={state.setExtractionResults}
        extractionTab={state.extractionTab}
        setExtractionTab={state.setExtractionTab}
        currentExtractingIndex={state.currentExtractingIndex}
        setCurrentExtractingIndex={state.setCurrentExtractingIndex}
        editedResults={state.editedResults}
        setEditedResults={state.setEditedResults}
        costApprovals={state.costApprovals}
        setCostApprovals={state.setCostApprovals}
        editingApprovedItem={state.editingApprovedItem}
        setEditingApprovedItem={state.setEditingApprovedItem}
        editingSkippedItem={state.editingSkippedItem}
        setEditingSkippedItem={state.setEditingSkippedItem}
        allSuppliers={state.allSuppliers}
        openAutocomplete={state.openAutocomplete}
        setOpenAutocomplete={state.setOpenAutocomplete}
        supplierSuggestions={state.supplierSuggestions}
        setSupplierSuggestions={state.setSupplierSuggestions}
        batchComplete={state.batchComplete}
        setBatchComplete={state.setBatchComplete}
        supplierInitialsMap={state.supplierInitialsMap}
        setSupplierInitialsMap={state.setSupplierInitialsMap}
        loading={state.loading}
        error={state.error}
        setError={state.setError}
        state={state.state}
        setState={state.setState}
        extractionSessionId={state.extractionSessionId}
        extractionResult={state.extractionResult}
        currentCutoverId={state.currentCutoverId}
        cutoverDate={state.cutoverDate}
        dropdownSelectionRef={state.dropdownSelectionRef}
        handleApproveItem={handleApproveItem}
        handleDiscardItem={handleDiscardItem}
        handleContinueBatch={handleContinueBatch}
        handleStartMigration={handleStartMigration}
        getSupplierSuggestions={supplierMatching.getSupplierSuggestions}
      />
    );
  }

  if (state.state === 'migrating') {
    return (
      <MigrationPhase migrationResult={state.migrationResult} />
    );
  }

  if (state.state === 'reporting' && state.reportData) {
    return (
      <ReportPhase reportData={state.reportData} />
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Inventory Migration</h2>
      <p className="text-gray-600">Please configure the migration to begin.</p>
    </div>
  );
};

