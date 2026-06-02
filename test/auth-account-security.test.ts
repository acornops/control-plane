import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { passwordChange } from '../src/controllers/auth-controller.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { db } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import { repo } from '../src/store/repository.js';
import { linkFederatedIdentity, resolveOidcLogin } from '../src/store/repository-users.js';
import { User } from '../src/types/domain.js';

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

function mockRedisForPasswordChange() {
  mock.method(redis, 'incr', async () => 1);
  mock.method(redis, 'expire', async () => 1);
  mock.method(redis, 'del', async () => 1);
  mock.method(redis, 'smembers', async () => ['old-session']);
  mock.method(redis, 'setex', async () => 'OK');
  mock.method(redis, 'sadd', async () => 1);
}

const user: User = {
  id: 'user-1',
  email: 'alice@example.com',
  displayName: 'Alice Example',
  createdAt: '2026-05-24T00:00:00.000Z'
};

function createAuth(userId: string) {
  return {
    userId,
    credential: { type: 'session' as const, sessionId: 'session-1' }
  };
}

describe('account security auth controller', () => {
  afterEach(() => mock.restoreAll());

  it('changes password for password-backed users and rotates sessions', async () => {
    const oldHash = await hashPassword('old secure passphrase');
    let storedHash = oldHash;

    mockRedisForPasswordChange();
    mock.method(repo, 'getUserById', async () => user);
    mock.method(repo, 'getPasswordCredentialByUserId', async () => ({
      user_id: user.id,
      username: 'alice',
      password_hash: storedHash,
      updated_at: '2026-05-24T00:00:00.000Z',
      last_login_at: null
    }));
    mock.method(repo, 'updatePasswordCredentialHash', async (_userId: string, nextHash: string) => {
      storedHash = nextHash;
      return true;
    });

    const res = createResponse();
    await passwordChange({
      auth: createAuth(user.id),
      body: {
        currentPassword: 'old secure passphrase',
        newPassword: 'fresh secure passphrase'
      },
      cookies: {},
      header: () => undefined,
      ip: '127.0.0.1'
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { status: 'ok' });
    assert.equal(await verifyPassword('fresh secure passphrase', storedHash), true);
    assert.equal(await verifyPassword('old secure passphrase', storedHash), false);
    assert.equal(res.cookies.size, 1);
  });

  it('rejects password change for OIDC-only users', async () => {
    mockRedisForPasswordChange();
    mock.method(repo, 'getUserById', async () => user);
    mock.method(repo, 'getPasswordCredentialByUserId', async () => null);

    const res = createResponse();
    await passwordChange({
      auth: createAuth(user.id),
      body: {
        currentPassword: 'old secure passphrase',
        newPassword: 'fresh secure passphrase'
      },
      cookies: {},
      header: () => undefined,
      ip: '127.0.0.1'
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      error: {
        code: 'PASSWORD_AUTH_NOT_CONFIGURED',
        message: 'This account does not have a local password',
        retryable: false
      }
    });
  });

  it('handles concurrent OIDC identity linking without surfacing a database conflict', async () => {
    const queries: string[] = [];
    const client = {
      query: mock.fn(async (sql: string) => {
        queries.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('INSERT INTO user_federated_identities')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('SELECT user_id, provider, subject') && queries.filter((query) => query.includes('SELECT user_id, provider, subject')).length > 1) {
          return { rowCount: 1, rows: [{ user_id: 'other-user' }] };
        }
        return { rowCount: 0, rows: [] };
      }),
      release: mock.fn()
    };
    mock.method(db, 'connect', async () => client);

    const result = await linkFederatedIdentity({
      userId: user.id,
      provider: 'keycloak',
      subject: 'subject-1',
      emailAtLinkTime: 'alice@example.com',
      emailVerified: true
    });

    assert.deepEqual(result, { status: 'linked_to_other_user' });
    assert.equal(queries.some((query) => query.includes('ON CONFLICT (provider, subject) DO NOTHING')), true);
  });

  it('does not mark a pending password account verified from an unlinked OIDC login attempt', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: mock.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('SELECT *') && sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
          return {
            rowCount: 1,
            rows: [{
              id: user.id,
              email: user.email,
              display_name: user.displayName,
              email_verified_at: null,
              email_verification_required: true,
              created_at: user.createdAt
            }]
          };
        }
        if (sql.includes('SELECT 1 FROM user_password_credentials')) {
          return { rowCount: 1, rows: [{ '?column?': 1 }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: mock.fn()
    };
    mock.method(db, 'connect', async () => client);
    mock.method(db, 'query', async () => ({ rowCount: 0, rows: [] }));

    const result = await resolveOidcLogin({
      provider: 'keycloak',
      subject: 'subject-1',
      email: user.email,
      displayName: user.displayName,
      emailVerified: true,
      requireVerifiedEmail: true
    });

    assert.deepEqual(result, { status: 'account_link_required' });
    assert.equal(queries.some(({ sql }) => sql.includes('UPDATE users')), false);
    assert.equal(queries.some(({ sql }) => sql.includes('INSERT INTO user_federated_identities')), false);
  });
});
