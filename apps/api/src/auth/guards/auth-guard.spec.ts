import { createHash } from 'crypto';
import { Reflector } from '@nestjs/core';
import { assert } from 'riteway/vitest';
import { AuthService } from '../auth.service';
import { AuthGuard, DeviceGuard } from './auth.guard';

// Real AuthService over a Prisma stub holding one live session, created on the
// device with token "device-A" (stored as its hash), for a manager at "centro".
function guardWithSession() {
  const prisma = {
    employeeSession: {
      findUnique: vi.fn().mockResolvedValue({
        id: 's1',
        deviceToken: createHash('sha256').update('device-A').digest('hex'),
        locationId: 'centro',
        expiresAt: new Date(Date.now() + 60_000),
        employee: {
          id: 'e1',
          isActive: true,
          assignments: [{ locationId: 'centro', role: 'MANAGER', isActive: true, location: { name: 'Centro' } }],
        },
      }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
  return { guard: new AuthGuard(new AuthService(prisma as any), new Reflector()), prisma };
}

function contextFor(headers: Record<string, string>) {
  const request = { headers: { 'x-session-token': 'session-1', ...headers } };
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => () => {}, getClass: () => class {} } as any;
}

/** 'allowed' or the refusal's message, plus how many times the session row was written. */
async function attempt(headers: Record<string, string>) {
  const { guard, prisma } = guardWithSession();
  const result = await guard.canActivate(contextFor(headers)).then(() => 'allowed', (e: any) => e.getResponse().message);
  const sessionWrites = prisma.employeeSession.update.mock.calls.length + prisma.employeeSession.delete.mock.calls.length;
  return { result, sessionWrites };
}

describe('AuthGuard device binding', () => {
  test('session used from the device that created it', async () => {
    assert({
      given: 'a session token sent with the device token it was created on',
      should: 'allow the request and record the activity',
      actual: await attempt({ authorization: 'Bearer device-A' }),
      expected: { result: 'allowed', sessionWrites: 1 },
    });
  });

  test('session used from another device', async () => {
    // Regressions: the device token was never compared to the session's (a
    // session worked from any machine); then it was compared only after the
    // session's activity had been written, and the refusal confirmed the token.
    assert({
      given: 'a session token sent with a different device token',
      should: 'refuse exactly like an unknown token, without touching the session',
      actual: await attempt({ authorization: 'Bearer device-B' }),
      expected: { result: 'Invalid session', sessionWrites: 0 },
    });
  });

  test('session used without a device token', async () => {
    assert({
      given: 'a session token sent with no device token',
      should: 'refuse exactly like an unknown token, without touching the session',
      actual: await attempt({}),
      expected: { result: 'Invalid session', sessionWrites: 0 },
    });
  });
});

describe('DeviceGuard', () => {
  test('device token without Bearer', async () => {
    const authService = { validateDeviceToken: vi.fn() };
    const request = { headers: { authorization: 'dt_raw' } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as any;

    assert({
      given: 'an Authorization header without "Bearer "',
      should: 'refuse it as a missing device token, without looking it up',
      actual: await new DeviceGuard(authService as any).canActivate(context).then(
        () => 'allowed',
        (e) => [e.getStatus(), authService.validateDeviceToken.mock.calls.length],
      ),
      expected: [401, 0],
    });
  });
});

describe('DeviceGuard errors', () => {
  test('database failure', async () => {
    const outage = new Error('connection refused');
    const authService = { validateDeviceToken: vi.fn().mockRejectedValue(outage) };
    const request = { headers: { authorization: 'Bearer dt_raw' } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as any;

    assert({
      given: 'a device check that fails with a database error',
      should: 'pass that error on (a 500), not report the device as invalid',
      actual: await new DeviceGuard(authService as any).canActivate(context).catch((e) => e),
      expected: outage,
    });
  });
});

describe('AuthGuard errors', () => {
  test('database failure', async () => {
    // Regression: any non-HTTP error became 401 "Invalid or expired session", so
    // a database outage logged everyone out instead of showing a server error.
    const outage = new Error('connection refused');
    const authService = { validateSession: vi.fn().mockRejectedValue(outage) };
    const guard = new AuthGuard(authService as any, new Reflector());

    assert({
      given: 'a session check that fails with a database error',
      should: 'pass that error on (a 500), not report the session as invalid',
      actual: await guard.canActivate(contextFor({ authorization: 'Bearer device-A' })).catch((e) => e),
      expected: outage,
    });
  });
});
