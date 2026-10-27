import { createHash } from 'crypto';
import { assert } from 'riteway/vitest';
import { AuthService } from './auth.service';
import { hashPassword } from './password';

// Same digest the hash-tokens migration writes: sha256, hex.
const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');

const centro = { id: 'centro', name: 'Centro', isActive: true };
const assignment = { locationId: 'centro', role: 'OWNER', isActive: true, location: centro };

// Real AuthService over a Prisma stub. The device row holds the hash of the
// raw token "dt_raw" the client keeps.
function authWithDevice() {
  const auth = new AuthService(undefined as any);
  const pin = '1234';
  const prisma = {
    employee: {
      findUnique: vi.fn().mockResolvedValue({ id: 'e1', name: 'Ana', isActive: true, passwordHash: hashPassword('correcta'), assignments: [assignment] }),
      findMany: vi.fn().mockResolvedValue([{ id: 'e1', name: 'Ana', pin: auth.hashPIN(pin, 's'), pinSalt: 's', assignments: [assignment] }]),
      update: vi.fn().mockResolvedValue({}),
    },
    device: {
      create: vi.fn().mockImplementation(({ data }) => ({ id: 'd2', ...data, location: centro })),
      findUnique: vi.fn().mockResolvedValue({ id: 'd1', isActive: true, locationId: 'centro', deviceToken: sha256('dt_raw') }),
      // Applies `omit` the way Prisma does.
      findMany: vi.fn().mockImplementation(({ omit = {} }) =>
        [{ id: 'd1', name: 'caja', isActive: true, locationId: 'centro', deviceToken: sha256('dt_raw') }].map((row) =>
          Object.fromEntries(Object.entries(row).filter(([key]) => !omit[key])),
        ),
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    employeeSession: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({
        id: 's1',
        employeeId: 'e1',
        locationId: 'centro',
        deviceToken: sha256('dt_raw'),
        expiresAt: new Date(Date.now() + 60_000),
        employee: { id: 'e1', isActive: true, assignments: [assignment] },
      }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    employeeLocationAssignment: { findFirst: vi.fn().mockResolvedValue(assignment) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  (auth as any).prisma = prisma;
  return { auth, prisma, pin };
}

describe('tokens at rest', () => {
  test('device activation', async () => {
    // Regression: device and session tokens were stored as-is, so anyone who
    // could read the database (a backup, a leaked dump) could act as any device.
    const { auth, prisma } = authWithDevice();
    const { deviceToken } = await auth.activateDevice({ email: 'ana@x.mx', password: 'correcta', deviceName: 'caja' });

    assert({
      given: 'a device activation',
      should: 'give the client the token and store only its hash',
      actual: prisma.device.create.mock.calls[0][0].data.deviceToken,
      expected: sha256(deviceToken),
    });
  });

  test('PIN login', async () => {
    const { auth, prisma, pin } = authWithDevice();
    const { sessionToken } = await auth.loginWithPIN({ pin, deviceToken: 'dt_raw' });
    const stored = prisma.employeeSession.create.mock.calls[0][0].data;

    assert({
      given: 'a PIN login from a device with its raw token',
      should: 'find the device by the token hash and store the session with hashes only',
      actual: {
        deviceLookup: prisma.device.findUnique.mock.calls[0][0].where,
        stored: { sessionToken: stored.sessionToken, deviceToken: stored.deviceToken },
      },
      expected: {
        deviceLookup: { deviceToken: sha256('dt_raw') },
        stored: { sessionToken: sha256(sessionToken), deviceToken: sha256('dt_raw') },
      },
    });
  });

  test('session use', async () => {
    const { auth, prisma } = authWithDevice();
    await auth.validateSession('st_raw', { deviceToken: 'dt_raw' });

    assert({
      given: 'a raw session token sent with its raw device token',
      should: 'find the session by the token hash and accept the device',
      actual: prisma.employeeSession.findUnique.mock.calls[0][0].where,
      expected: { sessionToken: sha256('st_raw') },
    });
  });

  test('session refresh', async () => {
    const { auth, prisma } = authWithDevice();
    const { sessionToken } = await auth.refreshSession('st_raw');

    assert({
      given: 'a session refresh',
      should: 'store only the new token hash',
      actual: prisma.employeeSession.update.mock.calls[1][0].data.sessionToken, // [0] is validateSession's lastActivityAt
      expected: sha256(sessionToken),
    });
  });

  test('logout', async () => {
    const { auth, prisma } = authWithDevice();
    await auth.logout('st_raw');

    assert({
      given: 'a logout with the raw session token',
      should: 'find the session by the token hash',
      actual: prisma.employeeSession.findUnique.mock.calls[0][0].where,
      expected: { sessionToken: sha256('st_raw') },
    });
  });

  test('device list', async () => {
    // Regression: GET /auth/devices returned every device row whole, tokens included.
    const { auth } = authWithDevice();
    const devices = await auth.getActiveDevicesForOwner('e1', 'centro');

    assert({
      given: "an owner listing the location's devices",
      should: 'not include any device token',
      actual: devices.some((d) => 'deviceToken' in d),
      expected: false,
    });
  });
});
