// Custom hook for managing Inventory Migration state
const { useState, useEffect, useRef } = React;

const useInventoryMigrationState = () => {
  // State machine: configuring | extracting | reviewing | migrating | reporting
  const [state, setState] = useState('configuring');
  
  // Phase 1: Configuration state
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [cutoverDate, setCutoverDate] = useState(new Date().toISOString().split('T')[0]);
  const [costBasis, setCostBasis] = useState('DESCRIPTION');
  const [batchSize, setBatchSize] = useState(50);
  
  // Phase 2: Extraction state
  const [extractionSessionId, setExtractionSessionId] = useState(null);
  const [extractionResult, setExtractionResult] = useState(null); // Full result object with metadata
  const [extractionResults, setExtractionResults] = useState([]);
  const [extractionTab, setExtractionTab] = useState('extracting'); // 'extracting', 'approved', 'discarded'
  const [currentExtractingIndex, setCurrentExtractingIndex] = useState(0); // Index of current item being reviewed
  const [editedResults, setEditedResults] = useState({});
  const [costApprovals, setCostApprovals] = useState({}); // Map of productId -> CostApproval data
  const [editingApprovedItem, setEditingApprovedItem] = useState(null); // productId of approved item being edited
  const [editingSkippedItem, setEditingSkippedItem] = useState(null); // productId of skipped item being edited
  const [allSuppliers, setAllSuppliers] = useState([]);
  const [supplierNameMappings, setSupplierNameMappings] = useState([]);
  const [openAutocomplete, setOpenAutocomplete] = useState({});
  const [supplierSuggestions, setSupplierSuggestions] = useState({});
  const [extractionApproved, setExtractionApproved] = useState(false);
  const [manualInputApproved, setManualInputApproved] = useState(false);
  const [currentBatchId, setCurrentBatchId] = useState(null);
  const [batchComplete, setBatchComplete] = useState(false);
  const [supplierInitialsMap, setSupplierInitialsMap] = useState({}); // Track learned initials: { supplierName: [initial1, initial2, ...] }
  const [sessionItemsByStatus, setSessionItemsByStatus] = useState(null); // Session-wide items grouped by status: { pending: [], approved: [], skipped: [] }
  
  // Session management state
  const [existingSessions, setExistingSessions] = useState([]);
  const [showSessionSelector, setShowSessionSelector] = useState(false);
  const [selectedSessionToResume, setSelectedSessionToResume] = useState(null);
  
  // Phase 3: Migration state
  const [migrationResult, setMigrationResult] = useState(null);
  const [migrationProgress, setMigrationProgress] = useState(null);
  
  // Phase 4: Report state
  const [reportData, setReportData] = useState(null);
  
  // Common state
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentCutoverId, setCurrentCutoverId] = useState(null);
  
  // Track when dropdown selection is made to prevent onBlur from using wrong value
  const dropdownSelectionRef = useRef({});

  // Reset current index when extracting items change
  useEffect(() => {
    // Calculate extracting items count from extractionResults
    const extractingCount = extractionResults.filter(r => 
      !r.migrationStatus || r.migrationStatus === 'PENDING'
    ).length;
    
    if (extractingCount > 0) {
      // Ensure index is within bounds
      if (currentExtractingIndex >= extractingCount) {
        setCurrentExtractingIndex(Math.max(0, extractingCount - 1));
      }
    } else {
      setCurrentExtractingIndex(0);
    }
  }, [extractionResults, currentExtractingIndex]);

  return {
    // State
    state, setState,
    selectedLocationId, setSelectedLocationId,
    cutoverDate, setCutoverDate,
    costBasis, setCostBasis,
    batchSize, setBatchSize,
    extractionSessionId, setExtractionSessionId,
    extractionResult, setExtractionResult,
    extractionResults, setExtractionResults,
    extractionTab, setExtractionTab,
    currentExtractingIndex, setCurrentExtractingIndex,
    editedResults, setEditedResults,
    costApprovals, setCostApprovals,
    editingApprovedItem, setEditingApprovedItem,
    editingSkippedItem, setEditingSkippedItem,
    allSuppliers, setAllSuppliers,
    supplierNameMappings, setSupplierNameMappings,
    openAutocomplete, setOpenAutocomplete,
    supplierSuggestions, setSupplierSuggestions,
    extractionApproved, setExtractionApproved,
    manualInputApproved, setManualInputApproved,
    currentBatchId, setCurrentBatchId,
    batchComplete, setBatchComplete,
    supplierInitialsMap, setSupplierInitialsMap,
    sessionItemsByStatus, setSessionItemsByStatus,
    existingSessions, setExistingSessions,
    showSessionSelector, setShowSessionSelector,
    selectedSessionToResume, setSelectedSessionToResume,
    migrationResult, setMigrationResult,
    migrationProgress, setMigrationProgress,
    reportData, setReportData,
    locations, setLocations,
    loading, setLoading,
    error, setError,
    currentCutoverId, setCurrentCutoverId,
    dropdownSelectionRef,
  };
};

