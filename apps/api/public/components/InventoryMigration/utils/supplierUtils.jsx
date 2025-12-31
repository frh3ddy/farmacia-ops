// Supplier Matching Utility Functions

// Function to get supplier suggestions based on input
const getSupplierSuggestions = (inputValue, originalSupplierName, allSuppliers, supplierNameMappings) => {
  if (!inputValue || inputValue.trim().length === 0) {
    return [];
  }

  const searchTerm = inputValue.trim().toLowerCase();
  const suggestions = [];

  // 1. First, check if input matches a supplier initial (case-insensitive) - EXACT match
  const initialMatches = allSuppliers
    .filter(s => {
      const initials = Array.isArray(s.initials) ? s.initials : (s.initials ? [s.initials] : []);
      return initials.some(init => init.toLowerCase() === searchTerm.toLowerCase()) && s.isActive;
    })
    .map(s => ({ id: s.id, name: s.name, contactInfo: s.contactInfo, matchType: 'initial', isExactMatch: true }));

  if (initialMatches.length > 0) {
    suggestions.push(...initialMatches);
  }

  // 2. Check if input matches a supplier name exactly (case-insensitive)
  const exactNameMatches = allSuppliers
    .filter(s => s.isActive && s.name.toLowerCase() === searchTerm)
    .map(s => ({ id: s.id, name: s.name, contactInfo: s.contactInfo, matchType: 'name', isExactMatch: true }))
    .filter(s => !suggestions.find(existing => existing.id === s.id)); // Avoid duplicates

  if (exactNameMatches.length > 0) {
    suggestions.push(...exactNameMatches);
  }

  // 3. Check local mappings for renamed suppliers
  const mappingMatches = supplierNameMappings
    .filter(m => 
      m.supplierOriginal.toLowerCase() === searchTerm || 
      m.new.toLowerCase() === searchTerm
    )
    .map(m => {
      // Find the supplier in allSuppliers by the mapped name
      const supplier = allSuppliers.find(s => s.name === m.new);
      if (supplier && supplier.isActive) {
        return { id: supplier.id, name: supplier.name, contactInfo: supplier.contactInfo, matchType: 'mapping', isExactMatch: true };
      }
      // If not found in suppliers, return a virtual suggestion
      return { id: null, name: m.new, contactInfo: null, matchType: 'mapping', isExactMatch: true };
    })
    .filter((s, index, self) => index === self.findIndex(t => t.name === s.name)); // Remove duplicates

  suggestions.push(...mappingMatches);

  // 4. Check supplier names that start with or contain the search term (partial matches)
  if (suggestions.length === 0) {
    const nameMatches = allSuppliers
      .filter(s => {
        if (!s.isActive) return false;
        const nameLower = s.name.toLowerCase();
        return nameLower.startsWith(searchTerm) || nameLower.includes(searchTerm);
      })
      .map(s => ({ id: s.id, name: s.name, contactInfo: s.contactInfo, matchType: 'name', isExactMatch: false }))
      .filter(s => !suggestions.find(existing => existing.name === s.name)); // Avoid duplicates

    suggestions.push(...nameMatches);
  }

  return suggestions.slice(0, 10); // Limit to 10 suggestions
};

// Function to auto-select supplier if there's an exact single match
const autoSelectSupplier = (
  inputValue, 
  originalSupplierName, 
  productId, 
  entryIdx, 
  isExtractedEntry, 
  currentResult,
  allSuppliers,
  supplierNameMappings,
  setEditedResults,
  setSupplierNameMappings,
  setOpenAutocomplete
) => {
  if (!inputValue || inputValue.trim().length === 0) {
    return null;
  }

  const suggestions = getSupplierSuggestions(inputValue, originalSupplierName, allSuppliers, supplierNameMappings);
  
  // Auto-select if there's exactly one exact match (by initial or exact name)
  const exactMatches = suggestions.filter(s => s.isExactMatch);
  
  if (exactMatches.length === 1) {
    const supplier = exactMatches[0];
    
    // Use functional update to ensure we have the latest state
    setEditedResults(prevResults => {
      const newResults = { ...prevResults };
      
      if (isExtractedEntry) {
        // For extracted entries
        if (!newResults[productId]) {
          newResults[productId] = { ...currentResult };
        }
        if (!newResults[productId].extractedEntries) {
          newResults[productId].extractedEntries = [...currentResult.extractedEntries];
        }
        if (!newResults[productId].extractedEntries[entryIdx]) {
          newResults[productId].extractedEntries[entryIdx] = { ...currentResult.extractedEntries[entryIdx] };
        }
        
        newResults[productId].extractedEntries[entryIdx] = {
          ...newResults[productId].extractedEntries[entryIdx],
          editedSupplierName: supplier.name,
          supplierId: supplier.id,
        };
        
        // Check if this entry is selected
        const isSelected = newResults[productId].extractedEntries[entryIdx].isSelected !== undefined 
          ? newResults[productId].extractedEntries[entryIdx].isSelected 
          : (entryIdx === newResults[productId].extractedEntries.length - 1);
        
        if (isSelected) {
          newResults[productId].selectedSupplierName = supplier.name;
          newResults[productId].selectedSupplierId = supplier.id;
        }
      } else {
        // For manual input
        if (!newResults[productId]) {
          newResults[productId] = { ...currentResult };
        }
        newResults[productId].selectedSupplierName = supplier.name;
        newResults[productId].selectedSupplierId = supplier.id;
      }
      
      return newResults;
    });
    
    // Update supplier name mapping if name changed (for extracted entries only)
    if (isExtractedEntry && originalSupplierName) {
      const isUnknownOrGeneral = !originalSupplierName || originalSupplierName === 'Unknown' || originalSupplierName === 'General';
      if (!isUnknownOrGeneral && supplier.name !== originalSupplierName) {
        setSupplierNameMappings(prev => {
          const filtered = prev.filter(m => m.supplierOriginal !== originalSupplierName);
          return [...filtered, { supplierOriginal: originalSupplierName, new: supplier.name }];
        });
      }
    }
    
    // Close autocomplete
    if (isExtractedEntry) {
      setOpenAutocomplete(prev => {
        const newState = { ...prev };
        delete newState[`${productId}_${entryIdx}`];
        return newState;
      });
    } else {
      setOpenAutocomplete(prev => {
        const newState = { ...prev };
        delete newState[productId];
        return newState;
      });
    }
    
    return supplier.name; // Return the supplier name so we can use it to update the input
  }
  
  return null; // No auto-selection
};

