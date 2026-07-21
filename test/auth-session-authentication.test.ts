import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { getSessionUser } from '../src/auth/session.js';
import { config } from '../src/config.js';
import { redis } from '../src/infra/redis.js';

const iso = (timestamp: number): string => new Date(timestamp).toISOString();

describe('browser session authentication edge cases', () => {
  afterEach(() => mock.restoreAll());

  it('ignores non-string session cookie values', async () => {
    let redisRead = false;
    mock.method(redis, 'get', async () => {
      redisRead = true;
      return null;
    });

    const result = await getSessionUser({
      cookies: { [config.SESSION_COOKIE_NAME]: { nested: 'session-1' } }
    } as never);

    assert.equal(result, null);
    assert.equal(redisRead, false);
  });

  it('rejects a session at its idle expiry instant', async () => {
    const now = 1_700_000_000_000;
    const deletedKeys: string[] = [];
    mock.method(Date, 'now', () => now);
    mock.method(redis, 'get', async () => JSON.stringify({
      version: 2,
      id: 'session-1',
      userId: 'user-1',
      createdAt: iso(now - 60_000),
      lastSeenAt: iso(now - 60_000),
      absoluteExpiresAt: iso(now + 60_000),
      idleExpiresAt: iso(now),
      authMethod: 'password'
    }));
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });
    mock.method(redis, 'srem', async () => 1);

    const result = await getSessionUser({
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    } as never);

    assert.equal(result, null);
    assert.equal(deletedKeys.includes('cp:session:session-1'), true);
  });

  it('rejects a session at its absolute expiry instant', async () => {
    const now = 1_700_000_000_000;
    const deletedKeys: string[] = [];
    mock.method(Date, 'now', () => now);
    mock.method(redis, 'get', async () => JSON.stringify({
      version: 2,
      id: 'session-1',
      userId: 'user-1',
      createdAt: iso(now - config.SESSION_MAX_AGE_SECONDS * 1000),
      lastSeenAt: iso(now - 60_000),
      absoluteExpiresAt: iso(now),
      idleExpiresAt: iso(now + 60_000),
      authMethod: 'password'
    }));
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });
    mock.method(redis, 'srem', async () => 1);

    const result = await getSessionUser({
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    } as never);

    assert.equal(result, null);
    assert.equal(deletedKeys.includes('cp:session:session-1'), true);
  });

  it('rejects a non-current session record', async () => {
    const now = 1_700_000_000_000;
    const deletedKeys: string[] = [];
    mock.method(Date, 'now', () => now);
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-1',
      userId: 'user-1',
      expiresAt: now
    }));
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });
    mock.method(redis, 'srem', async () => 1);

    const result = await getSessionUser({
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    } as never);

    assert.equal(result, null);
    assert.equal(deletedKeys.includes('cp:session:session-1'), true);
  });

  it('rejects session records stored under a mismatched id', async () => {
    const deletedKeys: string[] = [];
    const removedSetMembers: Array<[string, string]> = [];
    mock.method(redis, 'get', async () => JSON.stringify({
      id: 'session-2',
      userId: 'user-1',
      createdAt: Date.now() - 60_000,
      lastSeenAt: Date.now() - 60_000,
      absoluteExpiresAt: Date.now() + 60_000,
      idleExpiresAt: Date.now() + 60_000
    }));
    mock.method(redis, 'del', async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.length;
    });
    mock.method(redis, 'srem', async (key: string, member: string) => {
      removedSetMembers.push([key, member]);
      return 1;
    });

    const result = await getSessionUser({
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    } as never);

    assert.equal(result, null);
    assert.deepEqual(deletedKeys, ['cp:session:session-1']);
    assert.deepEqual(removedSetMembers, [['cp:user_sessions:user-1', 'session-1']]);
  });

  it('does not recreate a session deleted concurrently with idle refresh', async () => {
    const now = 1_700_000_000_000;
    mock.method(Date, 'now', () => now);
    mock.method(redis, 'get', async () => JSON.stringify({
      version: 2,
      id: 'session-1',
      userId: 'user-1',
      createdAt: iso(now - 60_000),
      lastSeenAt: iso(now - 60_000),
      absoluteExpiresAt: iso(now + 60_000),
      idleExpiresAt: iso(now + 60_000),
      authMethod: 'password'
    }));
    mock.method(redis, 'eval', async () => 0);

    const result = await getSessionUser({
      cookies: { [config.SESSION_COOKIE_NAME]: 'session-1' }
    } as never);

    assert.equal(result, null);
  });
});
