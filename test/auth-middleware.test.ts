import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { authenticatedHandler, requireUser } from '../src/auth/middleware.js';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
}

describe('requireUser middleware', () => {
  afterEach(() => mock.restoreAll());

  it('sets req.auth for a valid session cookie', async () => {
    const now = 1_700_000_000_000;
    const refreshedWrites: Array<{ key: string; ttl: number; value: string }> = [];
    mock.method(Date, 'now', () => now);
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-1',
      userId: 'user-1',
      createdAt: now - 60_000,
      lastSeenAt: now - 60_000,
      absoluteExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      idleExpiresAt: now + 60_000
    }));
    mock.method(redis, 'setex', async (key: string, ttl: number, value: string) => {
      refreshedWrites.push({ key, ttl, value });
      return 'OK';
    });

    const req = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    } as { cookies: Record<string, string>; auth?: unknown };
    const res = createResponse();
    let nextCalled = false;

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.deepEqual(req.auth, {
      userId: 'user-1',
      credential: { type: 'session', sessionId: 'session-1' }
    });
    assert.equal(refreshedWrites.length, 1);
    assert.equal(refreshedWrites[0].key, 'cp:session:session-1');
    assert.equal(refreshedWrites[0].ttl, config.SESSION_IDLE_TIMEOUT_SECONDS);
    assert.deepEqual(JSON.parse(refreshedWrites[0].value), {
      id: 'session-1',
      userId: 'user-1',
      createdAt: now - 60_000,
      lastSeenAt: now,
      absoluteExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
      idleExpiresAt: now + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000
    });
  });

  it('caps refreshed Redis TTL at the absolute expiry', async () => {
    const now = 1_700_000_000_000;
    const refreshedWrites: Array<{ ttl: number; value: string }> = [];
    mock.method(Date, 'now', () => now);
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-1',
      userId: 'user-1',
      createdAt: now - 60_000,
      lastSeenAt: now - 60_000,
      absoluteExpiresAt: now + 30_000,
      idleExpiresAt: now + 60_000
    }));
    mock.method(redis, 'setex', async (_key: string, ttl: number, value: string) => {
      refreshedWrites.push({ ttl, value });
      return 'OK';
    });

    const req = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    };
    const res = createResponse();

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal(refreshedWrites[0].ttl, 30);
    assert.equal(JSON.parse(refreshedWrites[0].value).idleExpiresAt, now + 30_000);
  });

  it('accepts legacy session records until their existing expiry', async () => {
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-1',
      userId: 'user-1',
      expiresAt: Date.now() + 60_000
    }));

    const req = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    } as { cookies: Record<string, string>; auth?: unknown };
    const res = createResponse();
    let nextCalled = false;

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.deepEqual(req.auth, {
      userId: 'user-1',
      credential: { type: 'session', sessionId: 'session-1' }
    });
  });

  it('returns 401 when the session cookie is missing', async () => {
    const req = { cookies: {} };
    const res = createResponse();
    let nextCalled = false;

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      error: { code: 'UNAUTHORIZED', message: 'User session required', retryable: false }
    });
  });

  it('returns 401 and cleans Redis state for an idle-expired session cookie', async () => {
    const now = 1_700_000_000_000;
    const deletedKeys: string[] = [];
    const removedSetMembers: Array<[string, string]> = [];
    mock.method(Date, 'now', () => now);
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-1',
      userId: 'user-1',
      createdAt: now - 60_000,
      lastSeenAt: now - 60_000,
      absoluteExpiresAt: now + 60_000,
      idleExpiresAt: now - 1
    }));
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });
    mock.method(redis, 'srem', async (key: string, member: string) => {
      removedSetMembers.push([key, member]);
      return 1;
    });

    const req = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    };
    const res = createResponse();

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(deletedKeys.includes('cp:session:session-1'), true);
    assert.deepEqual(removedSetMembers, [['cp:user_sessions:user-1', 'session-1']]);
  });

  it('returns 401 and cleans Redis state for an absolute-expired session cookie', async () => {
    const now = 1_700_000_000_000;
    const deletedKeys: string[] = [];
    const removedSetMembers: Array<[string, string]> = [];
    mock.method(Date, 'now', () => now);
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-1',
      userId: 'user-1',
      createdAt: now - config.SESSION_MAX_AGE_SECONDS * 1000,
      lastSeenAt: now - 60_000,
      absoluteExpiresAt: now - 1,
      idleExpiresAt: now + 60_000
    }));
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });
    mock.method(redis, 'srem', async (key: string, member: string) => {
      removedSetMembers.push([key, member]);
      return 1;
    });

    const req = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    };
    const res = createResponse();

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(deletedKeys.includes('cp:session:session-1'), true);
    assert.deepEqual(removedSetMembers, [['cp:user_sessions:user-1', 'session-1']]);
  });

  it('returns 401 and cleans Redis state for an expired legacy session cookie', async () => {
    const deletedKeys: string[] = [];
    const removedSetMembers: Array<[string, string]> = [];
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-1',
      userId: 'user-1',
      expiresAt: Date.now() - 1
    }));
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });
    mock.method(redis, 'srem', async (key: string, member: string) => {
      removedSetMembers.push([key, member]);
      return 1;
    });

    const req = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    };
    const res = createResponse();

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(deletedKeys.includes('cp:session:session-1'), true);
    assert.deepEqual(removedSetMembers, [['cp:user_sessions:user-1', 'session-1']]);
  });

  it('returns 401 and cleans Redis state for a malformed session record', async () => {
    const deletedKeys: string[] = [];
    const removedSetMembers: Array<[string, string]> = [];
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-1',
      userId: 'user-1',
      createdAt: Date.now()
    }));
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });
    mock.method(redis, 'srem', async (key: string, member: string) => {
      removedSetMembers.push([key, member]);
      return 1;
    });

    const req = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    };
    const res = createResponse();

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(deletedKeys.includes('cp:session:session-1'), true);
    assert.deepEqual(removedSetMembers, [['cp:user_sessions:user-1', 'session-1']]);
  });

  it('returns 401 and deletes invalid JSON session records', async () => {
    const deletedKeys: string[] = [];
    mock.method(redis, 'get', async () => '{');
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });

    const req = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    };
    const res = createResponse();

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 401);
    assert.deepEqual(deletedKeys, ['cp:session:session-1']);
  });

  it('does not accept legacy-shaped records without a valid user id', async () => {
    const deletedKeys: string[] = [];
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-1',
      expiresAt: Date.now() + 60_000
    }));
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });

    const req = {
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    };
    const res = createResponse();

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 401);
    assert.deepEqual(deletedKeys, ['cp:session:session-1']);
  });

  it('does not accept bearer tokens as user authentication', async () => {
    const req = {
      cookies: {},
      header: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer token-1' : undefined
    };
    const res = createResponse();
    let nextCalled = false;

    await requireUser(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('makes authenticated route handlers fail closed when req.auth is missing', async () => {
    const res = createResponse();
    let handlerCalled = false;
    const handler = authenticatedHandler(async () => {
      handlerCalled = true;
    });

    await handler({} as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(handlerCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, {
      error: { code: 'UNAUTHORIZED', message: 'User session required', retryable: false }
    });
  });

  it('passes authenticated requests to authenticated route handlers', async () => {
    const res = createResponse();
    let handlerUserId = '';
    const handler = authenticatedHandler(async (req) => {
      handlerUserId = req.auth.userId;
      res.status(204);
    });

    await handler({
      auth: {
        userId: 'user-1',
        credential: { type: 'session', sessionId: 'session-1' }
      }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(handlerUserId, 'user-1');
    assert.equal(res.statusCode, 204);
  });
});
