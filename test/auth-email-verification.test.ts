import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  passwordLogin,
  passwordSignup
} from '../src/controllers/auth-controller.js';
import {
  resendPasswordVerification,
  verifyPasswordEmail
} from '../src/controllers/email-verification-controller.js';
import { hashPassword } from '../src/auth/password.js';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';
import { repo } from '../src/store/repository.js';
import { User } from '../src/types/domain.js';

const mutableConfig = config as typeof config & {
  PASSWORD_EMAIL_VERIFICATION_REQUIRED: boolean;
  PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL: boolean;
  PASSWORD_EMAIL_VERIFICATION_RESEND_WINDOW_SECONDS: number;
  EMAIL_DELIVERY_MODE: 'smtp' | 'log' | 'disabled';
};

const user: User = {
  id: 'user-1',
  email: 'alice@example.com',
  displayName: 'Alice',
  createdAt: '2026-05-24T00:00:00.000Z'
};

function createResponse() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    cookies: new Map<string, string>(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    cookie(name: string, value: string) {
      this.cookies.set(name, value);
      return this;
    }
  };
}

function mockRedisForSession(): void {
  mock.method(redis, 'setex', async () => 'OK');
  mock.method(redis, 'sadd', async () => 1);
  mock.method(redis, 'expire', async () => 1);
}

function mockRedisForRateLimit(): void {
  mock.method(redis, 'incr', async () => 1);
  mock.method(redis, 'expire', async () => 1);
}

afterEach(() => mock.restoreAll());

describe('password email verification controller', () => {
  it('creates a pending account and does not issue a session when verification is required', async () => {
    const originalRequired = config.PASSWORD_EMAIL_VERIFICATION_REQUIRED;
    const originalAllowUnverified = config.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL;
    try {
      mutableConfig.PASSWORD_EMAIL_VERIFICATION_REQUIRED = true;
      mutableConfig.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL = false;
      mutableConfig.PASSWORD_EMAIL_VERIFICATION_RESEND_WINDOW_SECONDS = 300;
      mock.method(repo, 'createPasswordUser', async (input) => {
        assert.equal(input.emailVerificationRequired, true);
        assert.equal(typeof input.verificationTokenHash, 'string');
        assert.equal(input.verificationTokenHash!.length > 40, true);
        assert.equal(input.verificationTokenExpiresAt instanceof Date, true);
        return { status: 'created', user };
      });
      const res = createResponse();
      await passwordSignup({
        body: {
          email: user.email,
          username: 'alice',
          password: 'fresh secure passphrase',
          displayName: 'Alice'
        }
      } as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });

      assert.equal(res.statusCode, 201);
      assert.deepEqual(res.body, {
        status: 'verification_required',
        email: user.email,
        resendAfterSeconds: 300
      });
      assert.equal(res.cookies.size, 0);
    } finally {
      mutableConfig.PASSWORD_EMAIL_VERIFICATION_REQUIRED = originalRequired;
      mutableConfig.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL = originalAllowUnverified;
    }
  });

  it('invalidates the initial signup token when delivery is skipped', async () => {
    const originalRequired = config.PASSWORD_EMAIL_VERIFICATION_REQUIRED;
    const originalAllowUnverified = config.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL;
    const originalDeliveryMode = config.EMAIL_DELIVERY_MODE;
    let invalidatedTokenHash = '';
    try {
      mutableConfig.PASSWORD_EMAIL_VERIFICATION_REQUIRED = true;
      mutableConfig.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL = false;
      mutableConfig.EMAIL_DELIVERY_MODE = 'disabled';
      mock.method(repo, 'createPasswordUser', async (input) => {
        assert.equal(input.emailVerificationRequired, true);
        assert.equal(typeof input.verificationTokenHash, 'string');
        return { status: 'created', user };
      });
      mock.method(repo, 'invalidateEmailVerificationToken', async (tokenHash: string) => {
        invalidatedTokenHash = tokenHash;
      });
      mock.method(repo, 'retireOtherEmailVerificationTokens', async () => {
        throw new Error('should not retire stale tokens when delivery is skipped');
      });

      const res = createResponse();
      await passwordSignup({
        body: {
          email: user.email,
          username: 'alice',
          password: 'fresh secure passphrase',
          displayName: 'Alice'
        }
      } as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });

      assert.equal(res.statusCode, 503);
      assert.equal(typeof invalidatedTokenHash, 'string');
      assert.equal(invalidatedTokenHash.length > 40, true);
      assert.equal(res.cookies.size, 0);
    } finally {
      mutableConfig.PASSWORD_EMAIL_VERIFICATION_REQUIRED = originalRequired;
      mutableConfig.PASSWORD_SIGNUP_ALLOW_UNVERIFIED_EMAIL = originalAllowUnverified;
      mutableConfig.EMAIL_DELIVERY_MODE = originalDeliveryMode;
    }
  });

  it('rejects login for a pending password account without creating a session', async () => {
    mockRedisForRateLimit();
    let clearedAttemptKeys = 0;
    mock.method(redis, 'del', async (...keys: string[]) => {
      clearedAttemptKeys = keys.length;
      return keys.length;
    });
    const passwordHash = await hashPassword('fresh secure passphrase');
    mock.method(repo, 'getPasswordCredentialByIdentifier', async () => ({
      user,
      username: 'alice',
      passwordHash,
      lastLoginAt: undefined,
      emailVerifiedAt: undefined,
      emailVerificationRequired: true
    }));

    const res = createResponse();
    await passwordLogin({
      body: { identifier: user.email, password: 'fresh secure passphrase' },
      ip: '127.0.0.1'
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      error: {
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message: 'Verify your email before signing in.',
        retryable: false,
        details: { email: user.email }
      }
    });
    assert.equal(res.cookies.size, 0);
    assert.equal(clearedAttemptKeys, 2);
  });

  it('consumes a valid verification token once and creates a session', async () => {
    mockRedisForSession();
    mock.method(repo, 'consumeEmailVerificationToken', async () => ({ status: 'verified' as const, user }));

    const res = createResponse();
    await verifyPasswordEmail({
      body: { token: 'a'.repeat(43) }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { user, mode: 'password', status: 'verified' });
    assert.equal(res.cookies.size, 1);
  });

  it('treats malformed verification tokens as invalid links', async () => {
    mock.method(repo, 'consumeEmailVerificationToken', async () => {
      throw new Error('should not query malformed verification tokens');
    });

    const res = createResponse();
    await verifyPasswordEmail({
      body: { token: 'expired-token' }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      error: {
        code: 'EMAIL_VERIFICATION_TOKEN_INVALID',
        message: 'This verification link is no longer valid.',
        retryable: false
      }
    });
  });

  it('returns enumeration-safe resend responses for pending accounts', async () => {
    mockRedisForRateLimit();
    let retiredTokenHash = '';
    mock.method(repo, 'prepareEmailVerificationResend', async () => ({
      status: 'rotated' as const,
      email: user.email,
      expiresAt: new Date('2026-05-25T00:00:00.000Z')
    }));
    mock.method(repo, 'retireOtherEmailVerificationTokens', async (tokenHash: string) => {
      retiredTokenHash = tokenHash;
    });
    const res = createResponse();
    await resendPasswordVerification({
      body: { email: user.email },
      ip: '127.0.0.1'
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      status: 'ok',
      message: 'If an account is pending verification, a verification email will be sent.',
      resendAfterSeconds: config.PASSWORD_EMAIL_VERIFICATION_RESEND_WINDOW_SECONDS
    });
    assert.equal(typeof retiredTokenHash, 'string');
    assert.equal(retiredTokenHash.length > 40, true);
  });

  it('does not report resend success when stale token retirement fails after delivery', async () => {
    mockRedisForRateLimit();
    mock.method(repo, 'prepareEmailVerificationResend', async () => ({
      status: 'rotated' as const,
      email: user.email,
      expiresAt: new Date('2026-05-25T00:00:00.000Z')
    }));
    mock.method(repo, 'retireOtherEmailVerificationTokens', async () => {
      throw new Error('retire failed');
    });

    const res = createResponse();
    let forwardedError: unknown;
    await resendPasswordVerification({
      body: { email: user.email },
      ip: '127.0.0.1'
    } as never, res as never, (err?: unknown) => {
      forwardedError = err;
    });

    assert.equal(res.statusCode, 0);
    assert.match(forwardedError instanceof Error ? forwardedError.message : '', /retire failed/);
  });

  it('invalidates only the new resend token when delivery is skipped', async () => {
    const originalDeliveryMode = config.EMAIL_DELIVERY_MODE;
    let invalidatedTokenHash = '';
    try {
      mutableConfig.EMAIL_DELIVERY_MODE = 'disabled';
      mockRedisForRateLimit();
      mock.method(repo, 'prepareEmailVerificationResend', async () => ({
        status: 'rotated' as const,
        email: user.email,
        expiresAt: new Date('2026-05-25T00:00:00.000Z')
      }));
      mock.method(repo, 'invalidateEmailVerificationToken', async (tokenHash: string) => {
        invalidatedTokenHash = tokenHash;
      });
      mock.method(repo, 'retireOtherEmailVerificationTokens', async () => {
        throw new Error('should not retire stale tokens when delivery is skipped');
      });

      const res = createResponse();
      await resendPasswordVerification({
        body: { email: user.email },
        ip: '127.0.0.1'
      } as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });

      assert.equal(res.statusCode, 200);
      assert.equal(typeof invalidatedTokenHash, 'string');
      assert.equal(invalidatedTokenHash.length > 40, true);
      assert.deepEqual(res.body, {
        status: 'ok',
        message: 'If an account is pending verification, a verification email will be sent.'
      });
    } finally {
      mutableConfig.EMAIL_DELIVERY_MODE = originalDeliveryMode;
    }
  });
});
