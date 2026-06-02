import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { countUserSessions, createUserSession, revokeUserSessionsWithCount, setSessionCookie } from '../src/auth/session.js';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';

describe('browser session helpers', () => {
  afterEach(() => mock.restoreAll());

  it('creates session records with absolute and idle expiry', async () => {
    const now = 1_700_000_000_000;
    const writes: Array<{ key: string; ttl: number; value: string }> = [];
    const addedSetMembers: Array<[string, string]> = [];
    const setExpiries: Array<[string, number]> = [];
    mock.method(Date, 'now', () => now);
    mock.method(redis, 'setex', async (key: string, ttl: number, value: string) => {
      writes.push({ key, ttl, value });
      return 'OK';
    });
    mock.method(redis, 'sadd', async (key: string, member: string) => {
      addedSetMembers.push([key, member]);
      return 1;
    });
    mock.method(redis, 'expire', async (key: string, ttl: number) => {
      setExpiries.push([key, ttl]);
      return 1;
    });

    const sessionId = await createUserSession('user-1');

    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, `cp:session:${sessionId}`);
    assert.equal(writes[0].ttl, config.SESSION_IDLE_TIMEOUT_SECONDS);
    assert.deepEqual(JSON.parse(writes[0].value), {
      id: sessionId,
      userId: 'user-1',
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + config.SESSION_MAX_AGE_SECONDS * 1000,
      idleExpiresAt: now + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000
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

  it('counts and revokes only live session keys from the user session index', async () => {
    const deletedKeys: string[] = [];
    mock.method(redis, 'smembers', async () => ['session-1', 'stale-session']);
    mock.method(redis, 'exists', async (...keys: string[]) => keys.filter((key) => key === 'cp:session:session-1').length);
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });

    await assert.doesNotReject(async () => {
      assert.equal(await countUserSessions('user-1'), 1);
    });
    assert.equal(await revokeUserSessionsWithCount('user-1'), 1);
    assert.deepEqual(deletedKeys, ['cp:session:session-1', 'cp:session:stale-session', 'cp:user_sessions:user-1']);
  });
});
