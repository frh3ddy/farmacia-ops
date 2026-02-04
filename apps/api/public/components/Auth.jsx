// Auth Component - Handles login, setup, and session management
const { useState, useEffect, createContext, useContext } = React;

// Auth Context
const AuthContext = createContext(null);

// Custom hook to use auth
function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// API helper with auth headers
function authFetch(url, options = {}) {
  const deviceToken = localStorage.getItem('deviceToken');
  const sessionToken = localStorage.getItem('sessionToken');
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  if (deviceToken) {
    headers['Authorization'] = `Bearer ${deviceToken}`;
  }
  if (sessionToken) {
    headers['X-Session-Token'] = sessionToken;
  }
  
  return fetch(url, { ...options, headers });
}

// Login Form Component
function LoginForm({ onLogin, onSwitchToSetup }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [step, setStep] = useState('device'); // 'device' or 'pin'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deviceToken, setDeviceToken] = useState(localStorage.getItem('deviceToken'));

  // Check if device is already activated
  useEffect(() => {
    if (deviceToken) {
      setStep('pin');
    }
  }, [deviceToken]);

  const handleDeviceActivation = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/auth/device/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          deviceName: `Web Browser - ${navigator.userAgent.split(' ').slice(-1)[0]}`,
          deviceType: 'WEB',
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Device activation failed');
      }

      // Store device token
      localStorage.setItem('deviceToken', data.data.deviceToken);
      setDeviceToken(data.data.deviceToken);
      setStep('pin');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePinLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/auth/pin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${deviceToken}`,
        },
        body: JSON.stringify({ pin }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'PIN login failed');
      }

      // Store session token
      localStorage.setItem('sessionToken', data.data.sessionToken);
      onLogin(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeactivateDevice = () => {
    localStorage.removeItem('deviceToken');
    localStorage.removeItem('sessionToken');
    setDeviceToken(null);
    setStep('device');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <span className="material-icons text-white text-3xl">local_pharmacy</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Farmacia Ops</h1>
          <p className="text-gray-500 mt-1">
            {step === 'device' ? 'Activate this device' : 'Enter your PIN to continue'}
          </p>
        </div>

        {error && (
          <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-6 flex items-center">
            <span className="material-icons mr-2 text-sm">error</span>
            {error}
          </div>
        )}

        {step === 'device' ? (
          <form onSubmit={handleDeviceActivation}>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="owner@pharmacy.com"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="••••••••"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-400"
              >
                {loading ? 'Activating...' : 'Activate Device'}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handlePinLogin}>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">PIN</label>
                <input
                  type="password"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-center text-2xl tracking-widest"
                  placeholder="••••"
                  maxLength={6}
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading || pin.length < 4}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-400"
              >
                {loading ? 'Logging in...' : 'Login'}
              </button>
              <button
                type="button"
                onClick={handleDeactivateDevice}
                className="w-full text-gray-500 py-2 text-sm hover:text-gray-700"
              >
                Use a different account
              </button>
            </div>
          </form>
        )}

        {onSwitchToSetup && (
          <div className="mt-6 pt-6 border-t border-gray-200 text-center">
            <button
              onClick={onSwitchToSetup}
              className="text-blue-600 hover:text-blue-800 text-sm font-medium"
            >
              First time? Set up your account
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Setup Form Component (Initial Owner Creation)
function SetupForm({ onSetupComplete, onSwitchToLogin }) {
  const [formData, setFormData] = useState({
    ownerName: '',
    ownerEmail: '',
    ownerPassword: '',
    confirmPassword: '',
    ownerPin: '',
    confirmPin: '',
    locationName: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    // Validation
    if (formData.ownerPassword !== formData.confirmPassword) {
      setError('Passwords do not match');
      setLoading(false);
      return;
    }

    if (formData.ownerPin !== formData.confirmPin) {
      setError('PINs do not match');
      setLoading(false);
      return;
    }

    if (!/^\d{4,6}$/.test(formData.ownerPin)) {
      setError('PIN must be 4-6 digits');
      setLoading(false);
      return;
    }

    try {
      const response = await fetch('/auth/setup/initial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerName: formData.ownerName,
          ownerEmail: formData.ownerEmail,
          ownerPassword: formData.ownerPassword,
          ownerPin: formData.ownerPin,
          locationName: formData.locationName,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Setup failed');
      }

      setSuccess('Setup complete! You can now log in.');
      setTimeout(() => {
        onSetupComplete();
      }, 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-emerald-100 p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-emerald-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <span className="material-icons text-white text-3xl">rocket_launch</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Welcome to Farmacia Ops</h1>
          <p className="text-gray-500 mt-1">Let's set up your pharmacy</p>
        </div>

        {error && (
          <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-6 flex items-center">
            <span className="material-icons mr-2 text-sm">error</span>
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-50 text-green-700 px-4 py-3 rounded-lg mb-6 flex items-center">
            <span className="material-icons mr-2 text-sm">check_circle</span>
            {success}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div className="border-b pb-4 mb-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Owner Account</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Your Name</label>
                  <input
                    type="text"
                    name="ownerName"
                    value={formData.ownerName}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                    placeholder="John Doe"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    name="ownerEmail"
                    value={formData.ownerEmail}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                    placeholder="owner@pharmacy.com"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                    <input
                      type="password"
                      name="ownerPassword"
                      value={formData.ownerPassword}
                      onChange={handleChange}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                      placeholder="••••••••"
                      minLength={6}
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Confirm Password</label>
                    <input
                      type="password"
                      name="confirmPassword"
                      value={formData.confirmPassword}
                      onChange={handleChange}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                      placeholder="••••••••"
                      required
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">PIN (4-6 digits)</label>
                    <input
                      type="password"
                      name="ownerPin"
                      value={formData.ownerPin}
                      onChange={(e) => setFormData({ ...formData, ownerPin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-center"
                      placeholder="••••"
                      maxLength={6}
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Confirm PIN</label>
                    <input
                      type="password"
                      name="confirmPin"
                      value={formData.confirmPin}
                      onChange={(e) => setFormData({ ...formData, confirmPin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-center"
                      placeholder="••••"
                      maxLength={6}
                      required
                    />
                  </div>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Location</h3>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Pharmacy Name</label>
                <input
                  type="text"
                  name="locationName"
                  value={formData.locationName}
                  onChange={handleChange}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  placeholder="My Pharmacy"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-emerald-600 text-white py-3 rounded-lg font-medium hover:bg-emerald-700 transition-colors disabled:bg-gray-400 mt-6"
            >
              {loading ? 'Setting up...' : 'Complete Setup'}
            </button>
          </div>
        </form>

        <div className="mt-6 pt-6 border-t border-gray-200 text-center">
          <button
            onClick={onSwitchToLogin}
            className="text-emerald-600 hover:text-emerald-800 text-sm font-medium"
          >
            Already have an account? Login
          </button>
        </div>
      </div>
    </div>
  );
}

// Auth Provider Component
function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  // Check setup status and existing session on mount
  useEffect(() => {
    checkSetupAndSession();
  }, []);

  const checkSetupAndSession = async () => {
    try {
      // First check if setup is needed
      const setupResponse = await fetch('/auth/setup/status');
      const setupData = await setupResponse.json();
      
      if (setupData.success && setupData.data.needsSetup) {
        setNeedsSetup(true);
        setShowSetup(true);
        setLoading(false);
        return;
      }

      // Check for existing session
      const sessionToken = localStorage.getItem('sessionToken');
      if (sessionToken) {
        const response = await authFetch('/auth/me');
        const data = await response.json();
        
        if (data.success) {
          setUser(data.data);
        } else {
          // Session invalid, clear it
          localStorage.removeItem('sessionToken');
        }
      }
    } catch (err) {
      console.error('Auth check failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const login = (data) => {
    setUser({
      employee: data.employee,
      currentLocation: data.currentLocation,
      accessibleLocations: data.accessibleLocations,
    });
  };

  const logout = async () => {
    try {
      await authFetch('/auth/logout', { method: 'POST' });
    } catch (err) {
      console.error('Logout error:', err);
    }
    localStorage.removeItem('sessionToken');
    setUser(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (showSetup && needsSetup) {
    return (
      <SetupForm
        onSetupComplete={() => {
          setNeedsSetup(false);
          setShowSetup(false);
        }}
        onSwitchToLogin={() => setShowSetup(false)}
      />
    );
  }

  if (!user) {
    return (
      <LoginForm
        onLogin={login}
        onSwitchToSetup={needsSetup ? () => setShowSetup(true) : null}
      />
    );
  }

  return (
    <AuthContext.Provider value={{ user, logout, authFetch }}>
      {children}
    </AuthContext.Provider>
  );
}

// User Header Component (shows logged in user)
function UserHeader() {
  const { user, logout } = useAuth();
  
  return (
    <div className="flex items-center justify-between bg-white border-b px-6 py-3 mb-6">
      <div className="flex items-center space-x-4">
        <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
          <span className="text-blue-600 font-semibold">
            {user.employee.name.charAt(0).toUpperCase()}
          </span>
        </div>
        <div>
          <p className="font-medium text-gray-900">{user.employee.name}</p>
          <p className="text-sm text-gray-500">
            {user.currentLocation?.locationName || 'No location'} • {user.currentLocation?.role || 'Unknown role'}
          </p>
        </div>
      </div>
      <button
        onClick={logout}
        className="flex items-center space-x-2 text-gray-600 hover:text-red-600 transition-colors"
      >
        <span className="material-icons text-sm">logout</span>
        <span>Logout</span>
      </button>
    </div>
  );
}

// Make components globally available
window.AuthProvider = AuthProvider;
window.UserHeader = UserHeader;
window.useAuth = useAuth;
window.authFetch = authFetch;
