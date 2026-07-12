/**
 * Password hashing — scrypt via node:crypto (no external dependency).
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
 * The cost params are embedded so hashes remain verifiable if we tune them.
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(_scrypt);

// N=16384 (2^14), r=8, p=1 → ~16 MB, ~50-100ms. Solid for interactive login.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
// 128 * N * r bytes ≈ 16 MB; give scrypt generous headroom over the 32 MB default.
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })) as Buffer;
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  try {
    const [scheme, nStr, rStr, pStr, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = (await scrypt(password, salt, expected.length, {
      N: Number(nStr), r: Number(rStr), p: Number(pStr), maxmem: MAXMEM,
    })) as Buffer;
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
