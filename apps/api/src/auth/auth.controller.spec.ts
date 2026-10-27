import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { assert } from 'riteway/vitest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
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

// Real AuthService over a Prisma stub, behind a request AuthGuard already
// validated: session s1 of employee e1, now at centro, also assigned to norte.
function controllerWithGuardedRequest() {
  const prisma = {
    employeeSession: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const controller = new AuthController(new AuthService(prisma as any), {} as any, {} as any);
  const centro = { locationId: 'centro', role: 'MANAGER', isActive: true, location: { name: 'Centro' } };
  const norte = { locationId: 'norte', role: 'CASHIER', isActive: true, location: { name: 'Norte' } };
  const req = { session: { id: 's1' }, employee: { id: 'e1', assignments: [centro, norte] }, currentLocation: centro } as any;
  return { controller, prisma, req };
}

describe('AuthController session routes', () => {
  test('refresh', async () => {
    // Regression: refresh and switch-location took the raw header and validated
    // the session a second time (another lookup and write, without the device check).
    const { controller, prisma, req } = controllerWithGuardedRequest();
    await controller.refreshSession(req);

    assert({
      given: 'a session refresh behind AuthGuard',
      should: 'refresh the session the guard validated, without looking it up again',
      actual: { lookups: prisma.employeeSession.findUnique.mock.calls.length, updated: prisma.employeeSession.update.mock.calls[0][0].where },
      expected: { lookups: 0, updated: { id: 's1' } },
    });
  });

  test('switch location', async () => {
    const { controller, prisma, req } = controllerWithGuardedRequest();
    const { data } = await controller.switchLocation({ locationId: 'norte' }, req);

    assert({
      given: 'a switch to another assigned location behind AuthGuard',
      should: 'move the guard-validated session without looking it up again',
      actual: { lookups: prisma.employeeSession.findUnique.mock.calls.length, update: prisma.employeeSession.update.mock.calls[0][0], from: data.previousLocation?.locationId },
      expected: { lookups: 0, update: { where: { id: 's1' }, data: { locationId: 'norte' } }, from: 'centro' },
    });
  });
});

describe('AuthController PIN login', () => {
  test('device token without Bearer', async () => {
    // Regression: `.replace('Bearer ', '')` passed a header without the prefix
    // through as a token; AuthGuard's bearerToken() refuses it.
    const authService = { loginWithPIN: vi.fn() };
    const controller = new AuthController(authService as any, {} as any, {} as any);

    assert({
      given: 'a PIN login whose Authorization header lacks "Bearer "',
      should: 'refuse it as a missing device token, without trying the login',
      actual: await controller.loginWithPIN({ pin: '1234' } as any, 'dt_raw').then(
        () => 'ok',
        (e) => [e.getStatus(), authService.loginWithPIN.mock.calls.length],
      ),
      expected: [401, 0],
    });
  });
});
