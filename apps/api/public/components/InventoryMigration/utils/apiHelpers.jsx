// API Helper Functions for Inventory Migration

// Fetch locations
const fetchLocations = async (setLocations, setError) => {
  try {
    const response = await fetch('/locations');
    const data = await response.json();
    if (data.success) {
      setLocations(data.data || []);
    }
  } catch (err) {
    setError(err.message || 'Failed to fetch locations');
  }
};

// Fetch all suppliers
const fetchAllSuppliers = async (setAllSuppliers) => {
  try {
    const response = await fetch('/admin/inventory/cutover/suppliers');
    const data = await response.json();
    if (data.success) {
      const suppliers = data.suppliers || [];
      setAllSuppliers(suppliers);
      return suppliers;
    }
    return [];
  } catch (err) {
    console.error('Failed to fetch suppliers:', err);
    return [];
  }
};

// Fetch existing extraction sessions
const fetchExistingSessions = async (locationId, setExistingSessions) => {
  try {
    const url = locationId 
      ? `/admin/inventory/cutover/extraction-sessions?locationId=${locationId}`
      : '/admin/inventory/cutover/extraction-sessions';
    const response = await fetch(url);
    const data = await response.json();
    if (data.success) {
      // Filter to only IN_PROGRESS sessions
      const inProgressSessions = data.sessions.filter(s => s.status === 'IN_PROGRESS');
      setExistingSessions(inProgressSessions);
      return inProgressSessions;
    }
    return [];
  } catch (err) {
    console.error('Failed to fetch existing sessions:', err);
    return [];
  }
};

