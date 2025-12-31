// WebhookTest Component
const { useState, useEffect } = React;

const WebhookTest = () => {
  const [paymentId, setPaymentId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [locationId, setLocationId] = useState('L60AMVPDZJ48F');
  const [amount, setAmount] = useState(100);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [isPaused, setIsPaused] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);

  useEffect(() => {
    fetchStatus();
  }, []);

  const fetchStatus = async () => {
    try {
      const response = await fetch('/api/webhooks/square/test/status');
      const data = await response.json();
      if (data.success) {
        setIsPaused(data.paused || false);
      }
    } catch (err) {
      console.error('Failed to fetch webhook status:', err);
    } finally {
      setStatusLoading(false);
    }
  };

  const handlePause = async () => {
    try {
      const response = await fetch('/api/webhooks/square/test/pause', {
        method: 'POST',
      });
      const data = await response.json();
      if (data.success) {
        setIsPaused(true);
      }
    } catch (err) {
      setError(err.message || 'Failed to pause webhook testing');
    }
  };

  const handleResume = async () => {
    try {
      const response = await fetch('/api/webhooks/square/test/resume', {
        method: 'POST',
      });
      const data = await response.json();
      if (data.success) {
        setIsPaused(false);
      }
    } catch (err) {
      setError(err.message || 'Failed to resume webhook testing');
    }
  };

  const handleTest = async () => {
    if (isPaused) {
      setError('Webhook testing is paused. Please resume to send test webhooks.');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/webhooks/square/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentId: paymentId || undefined,
          orderId: orderId || undefined,
          locationId,
          amount,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setResult(data);
      } else {
        setError(data.message || 'Webhook test failed');
        if (data.paused) {
          setIsPaused(true);
        }
      }
    } catch (err) {
      setError(err.message || 'Failed to test webhook');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
        <h2>Test Webhook</h2>
        {!statusLoading && (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <span style={{ 
              padding: '5px 15px', 
              background: isPaused ? '#dc3545' : '#28a745', 
              color: 'white', 
              borderRadius: '4px',
              fontWeight: '600'
            }}>
              {isPaused ? '⏸ PAUSED' : '▶ ACTIVE'}
            </span>
            {isPaused ? (
              <button onClick={handleResume} style={{ background: '#28a745' }}>
                Resume
              </button>
            ) : (
              <button onClick={handlePause} style={{ background: '#dc3545' }}>
                Pause
              </button>
            )}
          </div>
        )}
      </div>
      <p style={{ marginBottom: '15px', color: '#666' }}>
        Simulate a Square payment webhook to test sale processing.
        {isPaused && <strong style={{ color: '#dc3545', display: 'block', marginTop: '5px' }}>⚠️ Webhook testing is paused. Jobs will not be sent.</strong>}
      </p>
      <div className="form-group">
        <label>Payment ID (optional, auto-generated if empty):</label>
        <input
          type="text"
          value={paymentId}
          onChange={(e) => setPaymentId(e.target.value)}
          placeholder="test_payment_123"
        />
      </div>
      <div className="form-group">
        <label>Order ID (optional, auto-generated if empty):</label>
        <input
          type="text"
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          placeholder="test_order_123"
        />
      </div>
      <div className="form-group">
        <label>Location ID:</label>
        <input
          type="text"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          required
        />
      </div>
      <div className="form-group">
        <label>Amount (cents):</label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(parseInt(e.target.value) || 0)}
          min="1"
        />
      </div>
      <button onClick={handleTest} disabled={loading || isPaused}>
        {loading ? 'Sending...' : isPaused ? 'Paused - Cannot Send' : 'Send Test Webhook'}
      </button>

      {error && <div className="error">{error}</div>}
      {result && (
        <div className="success">
          <h3>Webhook Test Result</h3>
          <p><strong>Status:</strong> {result.message}</p>
          <p><strong>Event ID:</strong> {result.eventId}</p>
          <p style={{ marginTop: '10px' }}>Check the worker logs to see if the sale was processed.</p>
        </div>
      )}
    </div>
  );
};

