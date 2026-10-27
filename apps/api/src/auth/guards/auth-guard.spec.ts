import { Reflector } from '@nestjs/core';
import { assert } from 'riteway/vitest';
import { AuthService } from '../auth.service';
import { AuthGuard } from './auth.guard';

// Real AuthService over a Prisma stub holding one live session, created on the
// device with token "device-A", for a manager at "centro".
function guardWithSession() {
  const prisma = {
    employeeSession: {
      findUnique: vi.fn().mockResolvedValue({
        id: 's1',
        deviceToken: 'device-A',
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
