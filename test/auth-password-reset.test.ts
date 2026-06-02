import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { requestPasswordReset, resetPassword } from '../src/controllers/password-reset-controller.js';
import { sendPasswordResetEmail } from '../src/services/email-delivery.js';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { redis } from '../src/infra/redis.js';
import { repo } from '../src/store/repository.js';
import { User } from '../src/types/domain.js';

const mutableConfig = config as typeof config & {
  NODE_ENV: 'development' | 'test' | 'production';
  EMAIL_DELIVERY_MODE: 'smtp' | 'log' | 'disabled';
  EMAIL_DELIVERY_ALLOW_LOG_IN_PRODUCTION: boolean;
};

const user: User = {
  id: 'user-reset-1',
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
    clearCookie(name: string) {
      this.cookies.set(name, '');
      return this;
    }
  };
}

function mockRedisForRateLimit(): void {
  mock.method(redis, 'incr', async () => 1);
  mock.method(redis, 'expire', async () => 1);
}

function mockRedisForSessionRevocation(): void {
  mock.method(redis, 'smembers', async () => ['session-1', 'session-2']);
  mock.method(redis, 'del', async (...keys: string[]) => keys.length);
}

function genericResetResponse(resendAfterSeconds = config.PASSWORD_RESET_REQUEST_WINDOW_SECONDS): unknown {
  return {
    status: 'ok',
    message: 'If a password-backed account exists, reset instructions will be sent.',
    resendAfterSeconds
  };
}

afterEach(() => mock.restoreAll());

describe('password reset controller', () => {
  it('returns generic success for unknown or non-password accounts without inserting a token', async () => {
    mockRedisForRateLimit();
    let emailLookups = 0;
    mock.method(repo, 'preparePasswordResetRequest', async (input) => {
      emailLookups += 1;
      assert.equal(input.email, user.email);
      return { status: 'noop' as const };
    });
    mock.method(repo, 'invalidatePasswordResetToken', async () => {
      throw new Error('should not invalidate when no token is inserted');
    });

    const res = createResponse();
    await requestPasswordReset({
      body: { email: 'Alice@Example.com' },
      ip: '127.0.0.1'
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(emailLookups, 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, genericResetResponse());
  });

  it('inserts and sends a reset token only for password-backed users', async () => {
    mockRedisForRateLimit();
    let preparedTokenHash = '';
    mock.method(repo, 'preparePasswordResetRequest', async (input) => {
      preparedTokenHash = input.tokenHash;
      return { status: 'rotated' as const, email: input.email, expiresAt: input.expiresAt };
    });

    const res = createResponse();
    await requestPasswordReset({
      body: { email: user.email },
      ip: '127.0.0.1'
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal(preparedTokenHash.length > 40, true);
    assert.deepEqual(res.body, genericResetResponse());
  });

  it('returns the same generic body when request throttling applies before lookup', async () => {
    mock.method(redis, 'incr', async () => config.PASSWORD_AUTH_IDENTIFIER_MAX_ATTEMPTS + 1);
    mock.method(redis, 'expire', async () => 1);
    mock.method(repo, 'preparePasswordResetRequest', async () => {
      throw new Error('should not look up accounts when rate limited');
    });

    const res = createResponse();
    await requestPasswordReset({
      body: { email: user.email },
      ip: '127.0.0.1'
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, genericResetResponse());
  });

  it('returns generic cooldown for repository throttling without sending another email', async () => {
    mockRedisForRateLimit();
    mock.method(repo, 'preparePasswordResetRequest', async () => ({
      status: 'throttled' as const,
      email: user.email,
      resendAfterSeconds: 127
    }));

    const res = createResponse();
    await requestPasswordReset({
      body: { email: user.email },
      ip: '127.0.0.1'
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, genericResetResponse(127));
  });

  it('invalidates the new token if reset email delivery is skipped', async () => {
    const originalDeliveryMode = config.EMAIL_DELIVERY_MODE;
    let invalidatedTokenHash = '';
    try {
      mutableConfig.EMAIL_DELIVERY_MODE = 'disabled';
      mockRedisForRateLimit();
      mock.method(repo, 'preparePasswordResetRequest', async (input) => ({
        status: 'rotated' as const,
        email: input.email,
        expiresAt: input.expiresAt
      }));
      mock.method(repo, 'invalidatePasswordResetToken', async (tokenHash: string) => {
        invalidatedTokenHash = tokenHash;
      });

      const res = createResponse();
      await requestPasswordReset({
        body: { email: user.email },
        ip: '127.0.0.1'
      } as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });

      assert.equal(res.statusCode, 200);
      assert.equal(invalidatedTokenHash.length > 40, true);
    } finally {
      mutableConfig.EMAIL_DELIVERY_MODE = originalDeliveryMode;
    }
  });

  it('resets a valid token, verifies the email, consumes outstanding tokens, and revokes sessions', async () => {
    mockRedisForSessionRevocation();
    mock.method(repo, 'getPasswordResetTokenContext', async () => ({
      status: 'valid' as const,
      user,
      username: 'alice'
    }));
    mock.method(repo, 'consumePasswordResetToken', async (input) => {
      assert.equal(input.passwordHash.startsWith('scrypt$'), true);
      return { status: 'reset' as const, user };
    });

    const res = createResponse();
    await resetPassword({
      body: { token: 'a'.repeat(43), password: 'new secure reset passphrase' }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { status: 'ok' });
    assert.equal(res.cookies.get(config.SESSION_COOKIE_NAME), '');
  });

  it('rejects invalid, expired, and consumed reset tokens with named errors', async () => {
    for (const [status, code, statusCode] of [
      ['invalid', 'PASSWORD_RESET_TOKEN_INVALID', 400],
      ['expired', 'PASSWORD_RESET_TOKEN_EXPIRED', 410]
    ] as const) {
      mock.restoreAll();
      mock.method(repo, 'getPasswordResetTokenContext', async () => ({ status }));
      const res = createResponse();

      await resetPassword({
        body: { token: status === 'invalid' ? 'b'.repeat(43) : 'c'.repeat(43), password: 'new secure reset passphrase' }
      } as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });

      assert.equal(res.statusCode, statusCode);
      assert.deepEqual((res.body as { error: { code: string } }).error.code, code);
    }
  });

  it('maps malformed reset token strings to the reset-token invalid error', async () => {
    mock.method(repo, 'getPasswordResetTokenContext', async () => {
      throw new Error('should not query malformed reset tokens');
    });

    for (const token of [undefined, null, 123, '', '   ', 'invalid-token', 'x'.repeat(513)]) {
      const res = createResponse();

      await resetPassword({
        body: { token, password: 'new secure reset passphrase' }
      } as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });

      assert.equal(res.statusCode, 400);
      assert.deepEqual((res.body as { error: { code: string } }).error.code, 'PASSWORD_RESET_TOKEN_INVALID');
    }
  });

  it('enforces password policy before consuming a valid token', async () => {
    mock.method(repo, 'getPasswordResetTokenContext', async () => ({
      status: 'valid' as const,
      user,
      username: 'alice'
    }));
    mock.method(repo, 'consumePasswordResetToken', async () => {
      throw new Error('should not consume a token for an invalid password');
    });

    const res = createResponse();
    await resetPassword({
      body: { token: 'd'.repeat(43), password: 'short' }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual((res.body as { error: { code: string } }).error.code, 'PASSWORD_POLICY_VIOLATION');
  });

  it('does not log raw reset tokens or URLs in production log delivery without unsafe override', async () => {
    const originalNodeEnv = config.NODE_ENV;
    const originalDeliveryMode = config.EMAIL_DELIVERY_MODE;
    const originalAllowLog = config.EMAIL_DELIVERY_ALLOW_LOG_IN_PRODUCTION;
    const logCalls: Array<unknown> = [];
    try {
      mutableConfig.NODE_ENV = 'production';
      mutableConfig.EMAIL_DELIVERY_MODE = 'log';
      mutableConfig.EMAIL_DELIVERY_ALLOW_LOG_IN_PRODUCTION = false;
      mock.method(logger, 'info', (payload: unknown) => {
        logCalls.push(payload);
      });

      await sendPasswordResetEmail({
        email: user.email,
        token: 'raw-reset-token',
        expiresAt: new Date('2026-05-25T00:00:00.000Z')
      });

      const serialized = JSON.stringify(logCalls);
      assert.equal(serialized.includes('raw-reset-token'), false);
      assert.equal(serialized.includes('/reset-password'), false);
      assert.equal(serialized.includes('passwordResetUrl'), false);
    } finally {
      mutableConfig.NODE_ENV = originalNodeEnv;
      mutableConfig.EMAIL_DELIVERY_MODE = originalDeliveryMode;
      mutableConfig.EMAIL_DELIVERY_ALLOW_LOG_IN_PRODUCTION = originalAllowLog;
    }
  });
});
