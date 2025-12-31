// Session Selector Modal Component
const SessionSelector = ({ 
  show, 
  existingSessions, 
  onResume, 
  onStartNew, 
  onClose 
}) => {
  if (!show) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '8px',
        padding: '24px',
        maxWidth: '600px',
        width: '90%',
        maxHeight: '80vh',
        overflow: 'auto',
      }}>
        <h3 style={{ marginTop: 0, marginBottom: '16px', fontSize: '18px', fontWeight: '600' }}>
          Resume Existing Session or Start New?
        </h3>
        
        {existingSessions.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <h4 style={{ marginBottom: '12px', fontSize: '14px', fontWeight: '600', color: '#374151' }}>
              In-Progress Sessions ({existingSessions.length})
            </h4>
            <div style={{ 
              border: '1px solid #e5e7eb', 
              borderRadius: '6px',
              maxHeight: '300px',
              overflow: 'auto',
            }}>
              {existingSessions.map(session => (
                <div
                  key={session.id}
                  onClick={() => onResume(session.id)}
                  style={{
                    padding: '12px 16px',
                    borderBottom: '1px solid #f3f4f6',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f9fafb'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'white'}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: '500', marginBottom: '4px', fontSize: '14px' }}>
                        Session from {new Date(session.createdAt).toLocaleString()}
                      </div>
                      <div style={{ fontSize: '12px', color: '#6b7280' }}>
                        Batch {session.currentBatch} of {session.totalBatches || '?'} • 
                        {' '}{session.processedItems} / {session.totalItems} items processed • 
                        {' '}{session.batchCount} batches extracted
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onResume(session.id);
                      }}
                      style={{
                        padding: '6px 12px',
                        backgroundColor: '#3b82f6',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: '500',
                      }}
                    >
                      Resume
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button
            onClick={onStartNew}
            style={{
              padding: '8px 16px',
              backgroundColor: '#6b7280',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '500',
            }}
          >
            Start New Session
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              backgroundColor: '#e5e7eb',
              color: '#374151',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '500',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

