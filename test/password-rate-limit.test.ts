import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { requestIp } from '../src/auth/client-ip.js';
import {
  clearPasswordLoginAttempts,
  registerPasswordLoginAttempt,
  registerPasswordResetRequest
} from '../src/auth/password-rate-limit.js';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';

const mutableConfig = config as typeof config & {
  PASSWORD_AUTH_MAX_ATTEMPTS: number;
  PASSWORD_AUTH_IDENTIFIER_MAX_ATTEMPTS: number;
  PASSWORD_RESET_REQUEST_WINDOW_SECONDS: number;
};

const originalMaxAttempts = config.PASSWORD_AUTH_MAX_ATTEMPTS;
const originalIdentifierMaxAttempts = config.PASSWORD_AUTH_IDENTIFIER_MAX_ATTEMPTS;
const originalResetRequestWindowSeconds = config.PASSWORD_RESET_REQUEST_WINDOW_SECONDS;

afterEach(() => {
  mutableConfig.PASSWORD_AUTH_MAX_ATTEMPTS = originalMaxAttempts;
  mutableConfig.PASSWORD_AUTH_IDENTIFIER_MAX_ATTEMPTS = originalIdentifierMaxAttempts;
  mutableConfig.PASSWORD_RESET_REQUEST_WINDOW_SECONDS = originalResetRequestWindowSeconds;
  mock.restoreAll();
});

function mockRedisCounters() {
  const counters = new Map<string, number>();
  mock.method(redis, 'incr', async (key: string) => {
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return next;
  });
  mock.method(redis, 'expire', async () => 1);
  mock.method(redis, 'del', async (...keys: string[]) => {
    for (const key of keys) {
      counters.delete(key);
    }
    return keys.length;
  });
  return counters;
}

describe('password rate limiting identity', () => {
  it('uses Express trusted-proxy IP resolution instead of raw X-Forwarded-For', () => {
    const req = {
      ip: '198.51.100.10',
      socket: { remoteAddress: '10.0.0.5' },
      header: (name: string) => name.toLowerCase() === 'x-forwarded-for' ? '203.0.113.99' : undefined
    };

    assert.equal(requestIp(req as never), '198.51.100.10');
  });

  it('enforces an identifier-wide limit even when attempts use different IPs', async () => {
    mockRedisCounters();
    mutableConfig.PASSWORD_AUTH_MAX_ATTEMPTS = 10;
    mutableConfig.PASSWORD_AUTH_IDENTIFIER_MAX_ATTEMPTS = 3;

    assert.equal(await registerPasswordLoginAttempt('admin@example.com', '198.51.100.1'), true);
    assert.equal(await registerPasswordLoginAttempt('admin@example.com', '198.51.100.2'), true);
    assert.equal(await registerPasswordLoginAttempt('admin@example.com', '198.51.100.3'), true);
    assert.equal(await registerPasswordLoginAttempt('admin@example.com', '198.51.100.4'), false);
  });

  it('clears both per-IP and identifier-wide counters after a successful login', async () => {
    const counters = mockRedisCounters();
    mutableConfig.PASSWORD_AUTH_MAX_ATTEMPTS = 10;
    mutableConfig.PASSWORD_AUTH_IDENTIFIER_MAX_ATTEMPTS = 1;

    assert.equal(await registerPasswordLoginAttempt('admin@example.com', '198.51.100.1'), true);
    assert.equal(await registerPasswordLoginAttempt('admin@example.com', '198.51.100.2'), false);
    await clearPasswordLoginAttempts('admin@example.com', '198.51.100.2');

    assert.equal(counters.size, 1);
  });

  it('uses the password reset request window for reset throttling keys', async () => {
    const expirations: Array<{ key: string; seconds: number }> = [];
    mutableConfig.PASSWORD_RESET_REQUEST_WINDOW_SECONDS = 45;
    mock.method(redis, 'incr', async () => 1);
    mock.method(redis, 'expire', async (key: string, seconds: number) => {
      expirations.push({ key, seconds });
      return 1;
    });

    assert.equal(await registerPasswordResetRequest('admin@example.com', '198.51.100.1'), true);

    assert.equal(expirations.length, 2);
    assert.equal(expirations.every((entry) => entry.seconds === 45), true);
    assert.equal(expirations.every((entry) => entry.key.includes('password_reset_request')), true);
  });
});
