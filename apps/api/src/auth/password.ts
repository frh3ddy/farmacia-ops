import * as crypto from 'crypto';

// OWASP's PBKDF2-HMAC-SHA512 recommendation. Hashes made before it was raised
// are "salt:hash" at 10,000 and get rehashed on the next successful login.
export const PASSWORD_ITERATIONS = 210_000;
const LEGACY_ITERATIONS = 10_000;

// ponytail: sync pbkdf2 blocks the event loop ~0.2 s per call; fine for rare
// device activations / password changes, switch to crypto.pbkdf2 if that changes.
function derive(password: string, salt: string, iterations: number): string {
  return crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
}

/** Stored as "salt:hash:iterations". */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(32).toString('hex');
  return `${salt}:${derive(password, salt, PASSWORD_ITERATIONS)}:${PASSWORD_ITERATIONS}`;
}

export function verifyPassword(password: string, stored: string): { valid: boolean; needsRehash: boolean } {
  const [salt, hash, iterationsPart] = stored.split(':');
  if (!salt || !hash) return { valid: false, needsRehash: false };
  const iterations = iterationsPart ? Number(iterationsPart) : LEGACY_ITERATIONS;
  const computed = Buffer.from(derive(password, salt, iterations));
  const expected = Buffer.from(hash);
  const valid = computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
  return { valid, needsRehash: valid && iterations < PASSWORD_ITERATIONS };
}
