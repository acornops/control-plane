import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  countUserSessions,
  createUserSession,
  deleteUserSession,
  revokeUserSessions,
  revokeUserSessionsWithCount,
  replaceUserSession,
  rotateUserSessions,
  setSessionCookie,
  getSessionUser
} from '../src/auth/session.js';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';

const iso = (timestamp: number): string => new Date(timestamp).toISOString();

describe('browser session helpers', () => {
  afterEach(() => mock.restoreAll());

  it('creates session records with absolute and idle expiry', async () => {
    const now = 1_700_000_000_000;
    const writes: Array<{ key: string; ttl: number; value: string }> = [];
    const addedSetMembers: Array<[string, string]> = [];
    const setExpiries: Array<[string, number]> = [];
    mock.method(Date, 'now', () => now);
    mock.method(redis, 'eval', async (
      _script: string,
      _keyCount: number,
      key: string,
      setKey: string,
      ttl: string,
      value: string,
      member: string,
      setTtl: string
    ) => {
      writes.push({ key, ttl: Number(ttl), value });
      addedSetMembers.push([setKey, member]);
      setExpiries.push([setKey, Number(setTtl)]);
      return 1;
    });

    const sessionId = await createUserSession('user-1', { authMethod: 'password' });

    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, `cp:session:${sessionId}`);
    assert.equal(writes[0].ttl, config.SESSION_IDLE_TIMEOUT_SECONDS);
    assert.deepEqual(JSON.parse(writes[0].value), {
      version: 2,
      id: sessionId,
      userId: 'user-1',
      createdAt: iso(now),
      lastSeenAt: iso(now),
      absoluteExpiresAt: iso(now + config.SESSION_MAX_AGE_SECONDS * 1000),
      idleExpiresAt: iso(now + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000),
      authMethod: 'password'
    });
    assert.deepEqual(addedSetMembers, [['cp:user_sessions:user-1', sessionId]]);
    assert.deepEqual(setExpiries, [['cp:user_sessions:user-1', config.SESSION_MAX_AGE_SECONDS]]);
  });

  it('sets browser session cookies for the absolute max age', () => {
    const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
    const res = {
      cookie(name: string, value: string, options: Record<string, unknown>) {
        cookies.push({ name, value, options });
      }
    };

    setSessionCookie(res as never, 'session-1');

    assert.deepEqual(cookies, [{
      name: config.SESSION_COOKIE_NAME,
      value: 'session-1',
      options: {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: config.SESSION_MAX_AGE_SECONDS * 1000,
        path: '/'
      }
    }]);
  });

  it('atomically consumes a session during logout', async () => {
    const now = Date.now();
    const storedSession = JSON.stringify({
      version: 2,
      id: 'session-1',
      userId: 'user-1',
      createdAt: iso(now),
      lastSeenAt: iso(now),
      absoluteExpiresAt: iso(now + 60_000),
      idleExpiresAt: iso(now + 60_000),
      authMethod: 'password'
    });
    let availableSession: string | null = storedSession;
    mock.method(redis, 'getdel', async () => {
      const result = availableSession;
      availableSession = null;
      return result;
    });
    mock.method(redis, 'srem', async () => 1);

    assert.equal((await deleteUserSession('session-1'))?.id, 'session-1');
    assert.equal(await deleteUserSession('session-1'), null);
  });

  it('keeps local logout successful after the session is consumed even if index cleanup fails', async () => {
    const now = Date.now();
    mock.method(redis, 'getdel', async () => JSON.stringify({
      version: 2,
      id: 'session-1',
      userId: 'user-1',
      createdAt: iso(now),
      lastSeenAt: iso(now),
      absoluteExpiresAt: iso(now + 60_000),
      idleExpiresAt: iso(now + 60_000),
      authMethod: 'password'
    }));
    mock.method(redis, 'srem', async () => { throw new Error('index unavailable'); });

    assert.equal((await deleteUserSession('session-1'))?.id, 'session-1');
  });

  it('rejects malformed session cookie values before constructing a Redis key', async () => {
    let redisRead = false;
    mock.method(redis, 'get', async () => {
      redisRead = true;
      return null;
    });

    assert.equal(await getSessionUser({
      cookies: { [config.SESSION_COOKIE_NAME]: '../unexpected' }
    } as never), null);
    assert.equal(await deleteUserSession('x'.repeat(129)), null);
    assert.equal(redisRead, false);
  });

  it('rotates and revokes indexed sessions with one atomic Redis operation', async () => {
    const calls: unknown[][] = [];
    mock.method(redis, 'eval', async (...args: unknown[]) => {
      calls.push(args);
      return 1;
    });

    const sessionId = await rotateUserSessions('user-1', { authMethod: 'password' });
    await revokeUserSessions('user-1');

    assert.equal(calls.length, 2);
    assert.equal(calls[0][1], 2);
    assert.equal(calls[0][2], 'cp:user_sessions:user-1');
    assert.equal(calls[0][3], `cp:session:${sessionId}`);
    assert.equal(calls[0][4], 'cp:session:');
    assert.equal(calls[1][1], 1);
    assert.equal(calls[1][2], 'cp:user_sessions:user-1');
  });

  it('atomically promotes a still-active password session to OIDC provenance', async () => {
    const calls: unknown[][] = [];
    mock.method(redis, 'eval', async (...args: unknown[]) => {
      calls.push(args);
      return calls.length === 1 ? 1 : 0;
    });

    const promoted = await replaceUserSession('session-1', 'user-1', {
      authMethod: 'oidc',
      provider: 'keycloak',
      issuer: 'https://identity.example.com/realms/acornops',
      idToken: 'secret-id-token'
    });
    const afterConcurrentLogout = await replaceUserSession('session-1', 'user-1', { authMethod: 'password' });

    assert.ok(promoted);
    assert.equal(afterConcurrentLogout, null);
    assert.equal(calls[0][1], 3);
    assert.equal(calls[0][2], 'cp:session:session-1');
    assert.equal(calls[0][4], 'cp:user_sessions:user-1');
    assert.equal(JSON.parse(String(calls[0][7])).oidc.idToken, 'secret-id-token');
  });

  it('counts and revokes only live session keys from the user session index', async () => {
    const revokedIndexes: string[] = [];
    mock.method(redis, 'smembers', async () => ['session-1', 'stale-session']);
    mock.method(redis, 'exists', async (...keys: string[]) => keys.filter((key) => key === 'cp:session:session-1').length);
    mock.method(redis, 'eval', async (_script: string, _keyCount: number, key: string) => {
      revokedIndexes.push(key);
      return 1;
    });

    await assert.doesNotReject(async () => {
      assert.equal(await countUserSessions('user-1'), 1);
    });
    assert.equal(await revokeUserSessionsWithCount('user-1'), 1);
    assert.deepEqual(revokedIndexes, ['cp:user_sessions:user-1']);
  });
});
