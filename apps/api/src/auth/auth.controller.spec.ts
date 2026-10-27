import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { assert } from 'riteway/vitest';
import { AuthController } from './auth.controller';
import { AuthGuard, ROLES_KEY } from './guards/auth.guard';

// The only auth routes allowed without AuthGuard: no session exists yet
// (setup, device activation, PIN login), or the call ends one (logout).
const PUBLIC_ROUTES = [
  'getSetupStatus',
  'getSquareLocations',
  'syncSquareLocationsForSetup',
  'initialSetup',
  'activateDevice',
  'loginWithPIN',
  'logout',
];

const handler = (name: string) => (AuthController.prototype as any)[name];
const routeNames = () =>
  Object.getOwnPropertyNames(AuthController.prototype).filter((name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, handler(name)) !== undefined);

describe('AuthController guards', () => {
  test('session routes', () => {
    // Regression: these validated the session token themselves, outside
    // AuthGuard, so a session worked from any device there. Checking every
    // route (not a list of known ones) also catches a new route added unguarded.
    assert({
      given: 'every auth route that is not on the public list',
      should: 'go through AuthGuard',
      actual: routeNames().filter(
        (name) => !PUBLIC_ROUTES.includes(name) && !(Reflect.getMetadata(GUARDS_METADATA, handler(name)) ?? []).includes(AuthGuard),
      ),
      expected: [],
    });
  });

  test('current session', async () => {
    const authService = { validateSession: vi.fn() };
    const controller = new AuthController(authService as any, {} as any, {} as any);
    // What AuthGuard attaches to the request after validating it.
    const req = {
      session: { expiresAt: new Date('2026-11-01'), lastActivityAt: new Date('2026-10-26') },
      employee: { id: 'e1', name: 'Ana', email: 'ana@x.mx' },
      currentLocation: { locationId: 'centro', role: 'MANAGER', location: { name: 'Centro' } },
      accessibleLocations: [{ locationId: 'centro', role: 'MANAGER', location: { name: 'Centro' } }],
    };

    const { data } = await controller.getCurrentSession(req as any);

    assert({
      given: 'a request AuthGuard already validated',
      should: 'answer from that session without validating it again',
      actual: { employeeId: data.employee.id, location: data.currentLocation?.locationName, revalidated: authService.validateSession.mock.calls.length },
      expected: { employeeId: 'e1', location: 'Centro', revalidated: 0 },
    });
  });

  test('owner-only routes', () => {
    assert({
      given: 'audit logs and expired-session cleanup',
      should: 'require the OWNER role',
      actual: ['getAuditLogs', 'cleanupExpiredSessions'].map((name) => Reflect.getMetadata(ROLES_KEY, handler(name))),
      expected: [['OWNER'], ['OWNER']],
    });
  });
});
