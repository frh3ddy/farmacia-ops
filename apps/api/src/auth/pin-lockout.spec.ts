import { createHash } from 'crypto';
import { assert } from 'riteway/vitest';
import { AuthService } from './auth.service';

const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');
const centro = { id: 'centro', name: 'Centro', isActive: true };

// Real AuthService over a Prisma stub: two activated devices at "centro" and
// one employee there whose PIN is 1234. `owners` are the employees with an
// OWNER assignment at centro.
function authAtCentro(owners = ['owner']) {
  const auth = new AuthService(undefined as any);
  const devices: Record<string, object> = {
    [sha256('dt_caja')]: { id: 'caja', isActive: true, locationId: 'centro', deviceToken: sha256('dt_caja') },
    [sha256('dt_oficina')]: { id: 'oficina', isActive: true, locationId: 'centro', deviceToken: sha256('dt_oficina') },
  };
  (auth as any).prisma = {
    device: {
      findUnique: vi.fn().mockImplementation(({ where }) =>
        where.id ? Object.values(devices).find((d: any) => d.id === where.id) ?? null : devices[where.deviceToken] ?? null,
      ),
      findMany: vi.fn().mockResolvedValue(Object.values(devices)),
      update: vi.fn().mockResolvedValue({}),
    },
    employeeLocationAssignment: {
      findFirst: vi.fn().mockImplementation(({ where }) => (owners.includes(where.employeeId) ? { role: 'OWNER' } : null)),
    },
    employee: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'e1', name: 'Ana', pin: auth.hashPIN('1234', 's'), pinSalt: 's', assignments: [{ locationId: 'centro', role: 'CASHIER', isActive: true, location: centro }] },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
    employeeSession: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return auth;
}

/** 'ok', or the refusal's HTTP status. */
const login = (auth: AuthService, deviceToken: string, pin: string) =>
  auth.loginWithPIN({ pin, deviceToken }).then(() => 'ok', (e) => e.getStatus());

async function wrongPins(auth: AuthService, deviceToken: string, times: number) {
  for (let i = 0; i < times; i++) await login(auth, deviceToken, '0000');
}

describe('PIN login lockout', () => {
  test('repeated wrong PINs', async () => {
    // Regression: a wrong PIN only threw "PIN incorrecto" (recordFailedPINAttempt
    // was never called), so a device could try every 4-digit PIN in minutes.
    const auth = authAtCentro();
    await wrongPins(auth, 'dt_caja', 5);

    assert({
      given: '5 wrong PINs from one device',
      should: 'refuse that device, even the right PIN, with 429',
      actual: await login(auth, 'dt_caja', '1234'),
      expected: 429,
    });
  });

  test('lockout message', async () => {
    const auth = authAtCentro();
    await wrongPins(auth, 'dt_caja', 5);

    assert({
      given: 'a locked-out device',
      should: 'tell staff, in Spanish, when to try again',
      actual: await auth.loginWithPIN({ pin: '1234', deviceToken: 'dt_caja' }).catch((e) => e.getResponse().message),
      expected: 'Demasiados intentos fallidos. Intenta de nuevo en 15 minutos.',
    });
  });

  test('another device', async () => {
    const auth = authAtCentro();
    await wrongPins(auth, 'dt_caja', 5);

    assert({
      given: 'a device locked out by wrong PINs',
      should: 'still let a different device log in',
      actual: await login(auth, 'dt_oficina', '1234'),
      expected: 'ok',
    });
  });

  test('a right PIN before the limit', async () => {
    const auth = authAtCentro();
    await wrongPins(auth, 'dt_caja', 4);
    await login(auth, 'dt_caja', '1234');
    await wrongPins(auth, 'dt_caja', 4);

    assert({
      given: 'a successful login between two runs of 4 wrong PINs',
      should: 'start the count over and keep the device usable',
      actual: await login(auth, 'dt_caja', '1234'),
      expected: 'ok',
    });
  });
});

describe('unlocking a device', () => {
  test('device list', async () => {
    const auth = authAtCentro();
    await wrongPins(auth, 'dt_caja', 5);
    const devices = await auth.getActiveDevicesForOwner('owner', 'centro');

    assert({
      given: 'one device locked out by wrong PINs',
      should: 'mark only that device as PIN-locked in the owner\'s device list',
      actual: devices.map((d) => [d.id, d.pinLocked]),
      expected: [['caja', true], ['oficina', false]],
    });
  });

  test('owner unlocks', async () => {
    const auth = authAtCentro();
    await wrongPins(auth, 'dt_caja', 5);
    await auth.unlockDevicePin('caja', 'owner');

    assert({
      given: 'an owner unlocking a locked-out device',
      should: 'let the right PIN log in again right away',
      actual: await login(auth, 'dt_caja', '1234'),
      expected: 'ok',
    });
  });

  test('non-owner unlocks', async () => {
    const auth = authAtCentro();
    await wrongPins(auth, 'dt_caja', 5);

    assert({
      given: 'someone who is not an owner at the device\'s location',
      should: 'refuse the unlock and keep the device locked',
      actual: [await auth.unlockDevicePin('caja', 'cashier').then(() => 'ok', (e) => e.getStatus()), await login(auth, 'dt_caja', '1234')],
      expected: [403, 429],
    });
  });
});
