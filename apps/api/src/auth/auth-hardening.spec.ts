import * as crypto from 'crypto';
import { HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { hashPassword, verifyPassword, PASSWORD_ITERATIONS } from './password';
import { assertLocationAccess, scopedLocationId } from './guards/auth.guard';

describe('password hashing', () => {
  it('verifies new hashes and flags legacy 10k-iteration ones for rehash', () => {
    expect(hashPassword('secreto1').split(':')[2]).toBe(String(PASSWORD_ITERATIONS));
    expect(verifyPassword('secreto1', hashPassword('secreto1'))).toEqual({ valid: true, needsRehash: false });

    const salt = 'abc';
    const legacy = `${salt}:${crypto.pbkdf2Sync('secreto1', salt, 10000, 64, 'sha512').toString('hex')}`;
    expect(verifyPassword('secreto1', legacy)).toEqual({ valid: true, needsRehash: true });
    expect(verifyPassword('otro', legacy)).toEqual({ valid: false, needsRehash: false });
  });
});

describe('device activation lockout', () => {
  it('locks an email after 5 failed passwords, even with the right one', async () => {
    const employee = { id: 'e1', isActive: true, passwordHash: hashPassword('correcta'), assignments: [] };
    const prisma = { employee: { findUnique: jest.fn().mockResolvedValue(employee) } };
    const auth = new AuthService(prisma as any);
    const attempt = (password: string) =>
      auth.activateDevice({ email: 'Owner@x.mx', password, deviceName: 'caja' } as any).catch((e) => e.getStatus());

    for (let i = 0; i < 5; i++) expect(await attempt('mala')).toBe(HttpStatus.UNAUTHORIZED);
    expect(await attempt('correcta')).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });
});

describe('location scoping', () => {
  const manager = { currentLocation: { role: 'MANAGER', locationId: 'centro' }, accessibleLocations: [{ locationId: 'centro', isActive: true }] };
  const owner = { currentLocation: { role: 'OWNER', locationId: 'centro' }, accessibleLocations: [] };

  it('gives non-owners their own location when none is asked for', () => {
    expect(scopedLocationId(manager)).toBe('centro');
    expect(scopedLocationId(owner)).toBeUndefined();
  });

  it('refuses another location to a non-owner', () => {
    expect(() => assertLocationAccess(manager, 'norte')).toThrow('Access denied');
    expect(() => assertLocationAccess(owner, 'norte')).not.toThrow();
  });
});
