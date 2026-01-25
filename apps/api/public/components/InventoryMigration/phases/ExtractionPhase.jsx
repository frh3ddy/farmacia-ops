// Extraction Phase Component - Full implementation
// This component contains the extraction workspace with tabs, item editors, and batch management
const { useEffect } = React;

const ExtractionPhase = ({
  // State
  extractionResults,
  setExtractionResults,
  extractionTab,
  setExtractionTab,
  currentExtractingIndex,
  setCurrentExtractingIndex,
  editedResults,
  setEditedResults,
  costApprovals,
  setCostApprovals,
  editingApprovedItem,
  setEditingApprovedItem,
  editingSkippedItem,
  setEditingSkippedItem,
  allSuppliers,
  openAutocomplete,
  setOpenAutocomplete,
  supplierSuggestions,
  setSupplierSuggestions,
  batchComplete,
  setBatchComplete,
  supplierInitialsMap,
  setSupplierInitialsMap,
  sessionItemsByStatus,
  loading,
  error,
  setError,
  state,
  setState,
  extractionSessionId,
  extractionResult,
  currentCutoverId,
  cutoverDate,
  dropdownSelectionRef,
  // Handlers
  handleApproveItem,
  handleDiscardItem,
  handleReusePreviousApprovals,
  handleContinueBatch,
  handleStartMigration,
  getSupplierSuggestions,
}) => {
  // Group extraction results by status (current batch)
  const groupedResults = {
    extracting: extractionResults.filter(r => 
      r.migrationStatus !== 'SKIPPED' && r.migrationStatus !== 'APPROVED'
    ),
    approved: extractionResults.filter(r => r.migrationStatus === 'APPROVED'),
    discarded: extractionResults.filter(r => r.migrationStatus === 'SKIPPED'),
  };
  
  // Use session-wide counts if available, otherwise fall back to current batch counts
  const sessionCounts = sessionItemsByStatus ? {
    extracting: sessionItemsByStatus.pending ? sessionItemsByStatus.pending.length : groupedResults.extracting.length,
    approved: sessionItemsByStatus.approved ? sessionItemsByStatus.approved.length : groupedResults.approved.length,
    skipped: sessionItemsByStatus.skipped ? sessionItemsByStatus.skipped.length : groupedResults.discarded.length,
  } : null;
  
  // Display counts: prefer session-wide if available, otherwise use current batch
  const displayCounts = sessionCounts || {
    extracting: groupedResults.extracting.length,
    approved: groupedResults.approved.length,
    skipped: groupedResults.discarded.length,
  };

  const totalItems = extractionResults.length;
  const remainingItems = groupedResults.extracting.length;
  const progress = totalItems > 0 ? ((totalItems - remainingItems) / totalItems * 100) : 0;

  // Calculate items that can be reused (have previous approvals but not approved for current cutover)
  const itemsWithPreviousApprovals = groupedResults.extracting.filter(
    r => r.isAlreadyApproved === true && 
         r.existingApprovedCost !== null && 
         r.existingApprovedCost !== undefined &&
         r.migrationStatus !== 'APPROVED' // Not already approved for current cutover
  );

  // Detect batch completion when all items are approved or discarded
  useEffect(() => {
    if (state === 'extracting' && !loading) {
      if (extractionResults.length === 0) {
        setBatchComplete(false);
        return;
      }
      
      const extractingItems = extractionResults.filter(r => 
        r.migrationStatus !== 'SKIPPED' && r.migrationStatus !== 'APPROVED'
      );
      
      if (extractingItems.length === 0) {
        setBatchComplete(true);
      } else {
        setBatchComplete(false);
      }
    } else if (loading) {
      setBatchComplete(false);
    }
  }, [extractionResults, state, loading]);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Extraction Workspace</h2>
      
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Header Stats */}
      <div className="bg-gray-50 rounded-lg p-4 flex items-center justify-between">
        <div className="flex gap-4">
          <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-medium">
            Total Items: {totalItems}
          </span>
          <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-sm font-medium">
            Remaining: {remainingItems}
          </span>
        </div>
        <div className="flex-1 mx-4">
          <div className="bg-gray-200 rounded-full h-2">
            <div 
              className="bg-blue-600 h-2 rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <div className="flex gap-2">
          {itemsWithPreviousApprovals.length > 0 && (
            <button
              onClick={handleReusePreviousApprovals}
              disabled={loading}
              className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              Reuse {itemsWithPreviousApprovals.length} Previous Approval{itemsWithPreviousApprovals.length !== 1 ? 's' : ''}
            </button>
          )}
          <button
            onClick={() => setState('configuring')}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Pause & Exit
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <div className="flex gap-2">
          <button
            onClick={() => {
              setExtractionTab('extracting');
              setCurrentExtractingIndex(0);
            }}
            className={`px-5 py-3 font-medium text-sm border-b-2 transition-colors ${
              extractionTab === 'extracting'
                ? 'border-primary text-primary font-semibold'
                : 'border-transparent text-gray-600 hover:text-primary'
            }`}
          >
            Extracting / Action Needed ({displayCounts.extracting})
          </button>
          <button
            onClick={() => setExtractionTab('approved')}
            className={`px-5 py-3 font-medium text-sm border-b-2 transition-colors ${
              extractionTab === 'approved'
                ? 'border-primary text-primary font-semibold'
                : 'border-transparent text-gray-600 hover:text-primary'
            }`}
          >
            Approved ({displayCounts.approved})
          </button>
          <button
            onClick={() => setExtractionTab('discarded')}
            className={`px-5 py-3 font-medium text-sm border-b-2 transition-colors ${
              extractionTab === 'discarded'
                ? 'border-primary text-primary font-semibold'
                : 'border-transparent text-gray-600 hover:text-primary'
            }`}
          >
            Discarded / Skipped ({displayCounts.skipped})
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="space-y-4">
        {extractionTab === 'extracting' && (
          <ExtractionItemEditor
            result={groupedResults.extracting[currentExtractingIndex]}
            groupedResults={groupedResults}
            currentExtractingIndex={currentExtractingIndex}
            setCurrentExtractingIndex={setCurrentExtractingIndex}
            editedResults={editedResults}
            setEditedResults={setEditedResults}
            allSuppliers={allSuppliers}
            openAutocomplete={openAutocomplete}
            setOpenAutocomplete={setOpenAutocomplete}
            supplierSuggestions={supplierSuggestions}
            setSupplierSuggestions={setSupplierSuggestions}
            dropdownSelectionRef={dropdownSelectionRef}
            cutoverDate={cutoverDate}
            getSupplierSuggestions={getSupplierSuggestions}
            onApprove={handleApproveItem}
            onDiscard={handleDiscardItem}
            setError={setError}
          />
        )}

        {extractionTab === 'approved' && (
          <div className="space-y-4">
            {groupedResults.approved.map(result => (
              <ApprovedItemEditor
                key={result.productId}
                result={result}
                editedResults={editedResults}
                setEditedResults={setEditedResults}
                costApprovals={costApprovals}
                editingApprovedItem={editingApprovedItem}
                setEditingApprovedItem={setEditingApprovedItem}
                allSuppliers={allSuppliers}
                openAutocomplete={openAutocomplete}
                setOpenAutocomplete={setOpenAutocomplete}
                supplierSuggestions={supplierSuggestions}
                setSupplierSuggestions={setSupplierSuggestions}
                dropdownSelectionRef={dropdownSelectionRef}
                extractionSessionId={extractionSessionId}
                extractionResult={extractionResult}
                currentCutoverId={currentCutoverId}
                getSupplierSuggestions={getSupplierSuggestions}
                setExtractionResults={setExtractionResults}
                setCostApprovals={setCostApprovals}
                setError={setError}
              />
            ))}
          </div>
        )}

        {extractionTab === 'discarded' && (
          <div className="space-y-4">
            {groupedResults.discarded.map(result => (
              <SkippedItemEditor
                key={result.productId}
                result={result}
                editedResults={editedResults}
                setEditedResults={setEditedResults}
                editingSkippedItem={editingSkippedItem}
                setEditingSkippedItem={setEditingSkippedItem}
                allSuppliers={allSuppliers}
                openAutocomplete={openAutocomplete}
                setOpenAutocomplete={setOpenAutocomplete}
                supplierSuggestions={supplierSuggestions}
                setSupplierSuggestions={setSupplierSuggestions}
                dropdownSelectionRef={dropdownSelectionRef}
                extractionSessionId={extractionSessionId}
                extractionResult={extractionResult}
                currentCutoverId={currentCutoverId}
                getSupplierSuggestions={getSupplierSuggestions}
                setExtractionResults={setExtractionResults}
                setCostApprovals={setCostApprovals}
                setError={setError}
              />
            ))}
          </div>
        )}
      </div>

      {/* Supplier Initials Learned Section */}
      <SupplierInitialsDisplay
        supplierInitialsMap={supplierInitialsMap}
        onClear={() => setSupplierInitialsMap({})}
        onRemove={(supplierName) => {
          setSupplierInitialsMap(prev => {
            const newMap = { ...prev };
            delete newMap[supplierName];
            return newMap;
          });
        }}
      />

      {/* Batch Complete Modal */}
      <BatchCompleteModal
        show={batchComplete}
        loading={loading}
        onContinue={handleContinueBatch}
        onReview={() => {
          setBatchComplete(false);
          setState('reviewing');
        }}
        onPause={() => {
          setBatchComplete(false);
          setState('configuring');
        }}
      />

      {/* Final Review Button */}
      {state === 'reviewing' && (
        <div className="flex justify-end">
          <button
            onClick={handleStartMigration}
            disabled={loading}
            className="px-6 py-2 bg-green-600 text-white rounded-md font-medium disabled:opacity-50"
          >
            {loading ? 'Starting Migration...' : 'Start Migration'}
          </button>
        </div>
      )}
    </div>
  );
};
