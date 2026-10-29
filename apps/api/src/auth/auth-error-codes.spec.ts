import { createHash } from 'crypto';
import { Reflector } from '@nestjs/core';
import { assert } from 'riteway/vitest';
import { AuthService } from './auth.service';
import { AuthGuard, DeviceGuard } from './guards/auth.guard';
import { hashPassword } from './password';

// The iOS app maps auth failures by `code` (messages are display text and may
// change). These pin the code each refusal carries.

const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');
const centro = { id: 'centro', name: 'Centro', isActive: true };

/** Real AuthService over a Prisma stub: device "dt_caja" at centro, Ana's PIN 1234, one session `session`. */
function authWith({ session = null as object | null, employee = null as object | null } = {}) {
  const auth = new AuthService(undefined as any);
  const caja = { id: 'caja', isActive: true, locationId: 'centro', deviceToken: sha256('dt_caja') };
  (auth as any).prisma = {
    device: {
      findUnique: vi.fn().mockImplementation(({ where }) => (where.deviceToken === caja.deviceToken ? caja : null)),
      update: vi.fn().mockResolvedValue({}),
    },
    employee: {
      findUnique: vi.fn().mockResolvedValue(employee),
      findMany: vi.fn().mockResolvedValue([
        { id: 'e1', name: 'Ana', pin: auth.hashPIN('1234', 's'), pinSalt: 's', assignments: [{ locationId: 'centro', role: 'CASHIER', isActive: true, location: centro }] },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
    employeeSession: {
      findUnique: vi.fn().mockResolvedValue(session),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return auth;
}

/** The refusal's status, code and lockedUntil (when present). */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => 'allowed',
    (e: any) => {
      const { code, lockedUntil } = e.getResponse();
      return { status: e.getStatus(), code, ...(lockedUntil && { lockedUntil: lockedUntil instanceof Date }) };
    },
  );

const sessionRow = (overrides: object = {}) => ({
  id: 's1',
  deviceToken: sha256('dt_caja'),
  locationId: 'centro',
  expiresAt: new Date(Date.now() + 60_000),
  employee: { id: 'e1', isActive: true, assignments: [{ locationId: 'centro', role: 'CASHIER', isActive: true, location: centro }] },
  ...overrides,
});

describe('auth error codes', () => {
  test('PIN login', async () => {
    const auth = authWith();
    assert({
      given: 'a wrong PIN',
      should: 'refuse with 401 PIN_INVALID',
      actual: await refusal(auth.loginWithPIN({ pin: '0000', deviceToken: 'dt_caja' })),
      expected: { status: 401, code: 'PIN_INVALID' },
    });

    for (let i = 0; i < 4; i++) await auth.loginWithPIN({ pin: '0000', deviceToken: 'dt_caja' }).catch(() => {});
    assert({
      given: '5 wrong PINs from one device',
      should: 'refuse with 429 TOO_MANY_ATTEMPTS and when the lock ends',
      actual: await refusal(auth.loginWithPIN({ pin: '1234', deviceToken: 'dt_caja' })),
      expected: { status: 429, code: 'TOO_MANY_ATTEMPTS', lockedUntil: true },
    });

    assert({
      given: 'a device token that is unknown or deactivated',
      should: 'refuse with 401 DEVICE_INVALID',
      actual: await refusal(authWith().loginWithPIN({ pin: '1234', deviceToken: 'dt_gone' })),
      expected: { status: 401, code: 'DEVICE_INVALID' },
    });
  });

  test('device activation', async () => {
    const activate = (employee: object | null) =>
      refusal(authWith({ employee }).activateDevice({ email: 'ana@farmacia.mx', password: 'secreto123', deviceName: 'Caja' }));

    assert({
      given: 'an email with no employee',
      should: 'refuse with 401 CREDENTIALS_INVALID',
      actual: await activate(null),
      expected: { status: 401, code: 'CREDENTIALS_INVALID' },
    });
    assert({
      given: 'a deactivated employee',
      should: 'refuse with 401 EMPLOYEE_INACTIVE',
      actual: await activate({ id: 'e1', isActive: false, assignments: [] }),
      expected: { status: 401, code: 'EMPLOYEE_INACTIVE' },
    });
    assert({
      given: 'an employee with no password set',
      should: 'refuse with 401 ACTIVATION_NOT_ALLOWED',
      actual: await activate({ id: 'e1', isActive: true, passwordHash: null, assignments: [] }),
      expected: { status: 401, code: 'ACTIVATION_NOT_ALLOWED' },
    });
    assert({
      given: 'a wrong password',
      should: 'refuse with 401 CREDENTIALS_INVALID',
      actual: await activate({ id: 'e1', isActive: true, passwordHash: hashPassword('otra-clave'), assignments: [] }),
      expected: { status: 401, code: 'CREDENTIALS_INVALID' },
    });
  });

  test('session use', async () => {
    const use = (session: object | null) => refusal(authWith({ session }).validateSession('st_x', { deviceToken: 'dt_caja' }));

    assert({
      given: 'a session token with no session',
      should: 'refuse with 401 SESSION_INVALID',
      actual: await use(null),
      expected: { status: 401, code: 'SESSION_INVALID' },
    });
    assert({
      given: 'a session past its expiry',
      should: 'refuse with 401 SESSION_EXPIRED',
      actual: await use(sessionRow({ expiresAt: new Date(Date.now() - 1000) })),
      expected: { status: 401, code: 'SESSION_EXPIRED' },
    });
    assert({
      given: 'a live session whose employee was deactivated',
      should: 'refuse with 401 EMPLOYEE_INACTIVE',
      actual: await use(sessionRow({ employee: { id: 'e1', isActive: false, assignments: [] } })),
      expected: { status: 401, code: 'EMPLOYEE_INACTIVE' },
    });
  });

  test('missing tokens', async () => {
    const attempt = (guard: AuthGuard | DeviceGuard, headers: Record<string, string>) =>
      refusal(
        guard.canActivate({
          switchToHttp: () => ({ getRequest: () => ({ headers }) }),
          getHandler: () => () => {},
          getClass: () => class {},
        } as any),
      );

    assert({
      given: 'a device-only route called with no device token',
      should: 'refuse with 401 DEVICE_REQUIRED',
      actual: await attempt(new DeviceGuard(authWith()), {}),
      expected: { status: 401, code: 'DEVICE_REQUIRED' },
    });
    assert({
      given: 'a request with a device token but no session token',
      should: 'refuse with 401 SESSION_REQUIRED',
      actual: await attempt(new AuthGuard(authWith(), new Reflector()), { authorization: 'Bearer dt_caja' }),
      expected: { status: 401, code: 'SESSION_REQUIRED' },
    });
  });
});
