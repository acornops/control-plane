import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hashPassword,
  generateEmailVerificationToken,
  hashEmailVerificationToken,
  isValidUsername,
  normalizeLoginIdentifier,
  validatePasswordPolicy,
  verifyPassword
} from '../src/auth/password.js';

describe('password auth helpers', () => {
  it('hashes and verifies passwords without storing plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');

    assert.match(hash, /^scrypt\$v1\$/);
    assert.equal(hash.includes('correct horse battery staple'), false);
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
    assert.equal(await verifyPassword('wrong password', hash), false);
  });

  it('normalizes login identifiers and validates usernames', () => {
    assert.equal(normalizeLoginIdentifier('  User.Name  '), 'user.name');
    assert.equal(isValidUsername('platform-admin_1'), true);
    assert.equal(isValidUsername('ab'), false);
    assert.equal(isValidUsername('user@example.com'), false);
    assert.equal(isValidUsername('-leadingdash'), false);
  });

  it('rejects malformed password hashes', async () => {
    assert.equal(await verifyPassword('password', 'not-a-real-hash'), false);
  });

  it('generates high-entropy email verification tokens and hashes them for storage', () => {
    const token = generateEmailVerificationToken();
    const secondToken = generateEmailVerificationToken();
    const hash = hashEmailVerificationToken(token);

    assert.notEqual(token, secondToken);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(hash.includes(token), false);
    assert.equal(hashEmailVerificationToken(token), hash);
    assert.notEqual(hashEmailVerificationToken(secondToken), hash);
  });

  it('enforces local password policy without truncating long passwords', () => {
    assert.deepEqual(validatePasswordPolicy('short-password'), {
      valid: false,
      message: 'Password must be at least 15 characters.'
    });
    assert.equal(validatePasswordPolicy('a'.repeat(1025)).valid, false);
    assert.equal(validatePasswordPolicy('correct horse battery staple').valid, false);
    assert.equal(validatePasswordPolicy('unique long passphrase', { email: 'user@example.com' }).valid, true);
    assert.equal(validatePasswordPolicy('unique user passphrase', { email: 'user@example.com' }).valid, false);
  });
});
