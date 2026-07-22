import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { ensureOidcPrelinkedIdentities } from '../src/store/repository-oidc-prelinks.js';

afterEach(() => mock.restoreAll());

describe('OIDC prelinked identities', () => {
  it('attaches an explicit subject to an existing authless seed user', async () => {
    const queries: string[] = [];
    const client = {
      query: mock.fn(async (sql: string) => {
        queries.push(sql);
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
        if (sql.includes('INSERT INTO users')) return { rowCount: 0, rows: [] };
        if (sql.includes('SELECT id FROM users')) return { rowCount: 1, rows: [{ id: 'user-1' }] };
        if (sql.includes('WHERE user_id = $1')) return { rowCount: 0, rows: [] };
        if (sql.includes('INSERT INTO user_federated_identities')) {
          return { rowCount: 1, rows: [{ user_id: 'user-1' }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: mock.fn()
    };
    mock.method(db, 'connect', async () => client);

    await ensureOidcPrelinkedIdentities('dex', [{
      subject: 'u-dev-local',
      email: 'dev@acornops.local',
      displayName: 'Dev User',
      emailVerified: true
    }]);

    assert.equal(queries.some((sql) => sql.includes('ON CONFLICT (provider, subject) DO NOTHING')), true);
    assert.equal(queries.at(-1), 'COMMIT');
  });

  it('is idempotent for the same mapping', async () => {
    const client = {
      query: mock.fn(async (sql: string) => {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
        if (sql.includes('INSERT INTO users')) return { rowCount: 0, rows: [] };
        if (sql.includes('SELECT id FROM users')) return { rowCount: 1, rows: [{ id: 'user-1' }] };
        if (sql.includes('WHERE user_id = $1')) {
          return { rowCount: 1, rows: [{ user_id: 'user-1', provider: 'dex', subject: 'u-dev-local' }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: mock.fn()
    };
    mock.method(db, 'connect', async () => client);

    await ensureOidcPrelinkedIdentities('dex', [{
      subject: 'u-dev-local',
      email: 'dev@acornops.local',
      displayName: 'Dev User',
      emailVerified: true
    }]);
    assert.equal(client.query.mock.calls.some((call) => String(call.arguments[0]).includes(
      'INSERT INTO user_federated_identities'
    )), false);
  });

  it('fails startup rather than replacing a conflicting identity', async () => {
    const client = {
      query: mock.fn(async (sql: string) => {
        if (['BEGIN', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
        if (sql === 'COMMIT') throw new Error('Unexpected commit');
        if (sql.includes('INSERT INTO users')) return { rowCount: 0, rows: [] };
        if (sql.includes('SELECT id FROM users')) return { rowCount: 1, rows: [{ id: 'user-1' }] };
        if (sql.includes('WHERE user_id = $1')) {
          return { rowCount: 1, rows: [{ user_id: 'user-1', provider: 'dex', subject: 'other-subject' }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: mock.fn()
    };
    mock.method(db, 'connect', async () => client);

    await assert.rejects(
      ensureOidcPrelinkedIdentities('dex', [{
        subject: 'u-dev-local',
        email: 'dev@acornops.local',
        displayName: 'Dev User',
        emailVerified: true
      }]),
      /already has a different federated identity/
    );
    assert.equal(client.query.mock.calls.some((call) => call.arguments[0] === 'ROLLBACK'), true);
  });
});
