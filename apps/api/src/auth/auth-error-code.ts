/**
 * Stable codes on auth refusals. Clients (the iOS app) branch on these, not on
 * `message`, which is display text and may change. Only add values; never rename.
 */
export const AuthErrorCode = {
  PIN_INVALID: 'PIN_INVALID',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  CREDENTIALS_INVALID: 'CREDENTIALS_INVALID',
  EMPLOYEE_INACTIVE: 'EMPLOYEE_INACTIVE',
  ACTIVATION_NOT_ALLOWED: 'ACTIVATION_NOT_ALLOWED',
  DEVICE_INVALID: 'DEVICE_INVALID',
  DEVICE_REQUIRED: 'DEVICE_REQUIRED',
  SESSION_INVALID: 'SESSION_INVALID',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_REQUIRED: 'SESSION_REQUIRED',
} as const;
