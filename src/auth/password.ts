import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const PASSWORD_HASH_PREFIX = 'scrypt';
const PASSWORD_HASH_VERSION = 'v1';
const MIN_PASSWORD_LENGTH = 15;
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'qwerty',
  'qwerty123',
  'letmein',
  'welcome',
  'welcome1',
  'admin',
  'administrator',
  'changeme',
  'correcthorsebatterystaple',
  'acornops',
  'acornops123',
  '123456789012345'
]);

export function normalizeLoginIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidUsername(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(value);
}

function normalizedPasswordToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function validatePasswordPolicy(
  password: string,
  context: { email?: string; username?: string; displayName?: string } = {}
): { valid: true } | { valid: false; message: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > 1024) {
    return { valid: false, message: 'Password must be no more than 1024 characters.' };
  }

  const normalized = normalizedPasswordToken(password);
  if (COMMON_PASSWORDS.has(normalized)) {
    return { valid: false, message: 'Password is too common.' };
  }

  const emailLocalPart = context.email?.split('@')[0];
  const contextValues = ['acornops', context.username, context.displayName, emailLocalPart]
    .filter((value): value is string => typeof value === 'string' && value.trim().length >= 4)
    .map(normalizedPasswordToken)
    .filter((value) => value.length >= 4);

  if (contextValues.some((value) => normalized.includes(value))) {
    return { valid: false, message: 'Password is too similar to account details.' };
  }

  return { valid: true };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derived = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY
  });

  return [
    PASSWORD_HASH_PREFIX,
    PASSWORD_HASH_VERSION,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    String(SCRYPT_KEY_LENGTH),
    salt,
    derived.toString('base64url')
  ].join('$');
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 8) return false;

  const [prefix, version, nText, rText, pText, keyLengthText, salt, digest] = parts;
  if (prefix !== PASSWORD_HASH_PREFIX || version !== PASSWORD_HASH_VERSION || !salt || !digest) {
    return false;
  }

  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  const keyLength = Number(keyLengthText);
  if (![N, r, p, keyLength].every((value) => Number.isInteger(value) && value > 0)) {
    return false;
  }

  const expected = Buffer.from(digest, 'base64url');
  if (expected.length !== keyLength) return false;

  const actual = await scryptAsync(password, salt, keyLength, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAX_MEMORY
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function generateEmailVerificationToken(): string {
  return generateAuthEmailToken();
}

export function hashEmailVerificationToken(token: string): string {
  return hashAuthEmailToken(token);
}

export function generateAuthEmailToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashAuthEmailToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function isPlausibleAuthEmailToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,512}$/.test(token);
}
