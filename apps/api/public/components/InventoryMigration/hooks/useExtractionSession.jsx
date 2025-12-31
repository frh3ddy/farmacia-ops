// Custom hook for extraction session management
const { useState } = React;

const useExtractionSession = (setExistingSessions) => {
  const [showSessionSelector, setShowSessionSelector] = useState(false);
  const [selectedSessionToResume, setSelectedSessionToResume] = useState(null);

  const fetchExistingSessions = async (locationId) => {
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

  return {
    showSessionSelector,
    setShowSessionSelector,
    selectedSessionToResume,
    setSelectedSessionToResume,
    fetchExistingSessions,
  };
};

