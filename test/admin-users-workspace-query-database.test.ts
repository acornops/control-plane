import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Client } from 'pg';
import { db } from '../src/infra/db.js';
import { listUsers } from '../src/controllers/admin-controller.js';

test('workspace filtering executes against PostgreSQL with literal matching and complete bounded pages', { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
  const client = new Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Transaction-local tables shadow production names; no shared fixtures are changed.
    await client.query(`
      CREATE TEMP TABLE users (id text PRIMARY KEY, email text, display_name text, email_verified_at timestamptz, created_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE workspaces (id text PRIMARY KEY, name text) ON COMMIT DROP;
      CREATE TEMP TABLE workspace_memberships (user_id text, workspace_id text) ON COMMIT DROP;
      CREATE TEMP TABLE user_password_credentials (user_id text, last_login_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE user_federated_identities (user_id text, last_login_at timestamptz) ON COMMIT DROP;
      INSERT INTO users SELECT 'user-' || lpad(i::text, 4, '0'), 'person' || i || '@example.test', 'Person ' || i, CASE WHEN i % 2 = 0 THEN '2026-01-01'::timestamptz END, '2026-01-01'::timestamptz FROM generate_series(1, 1000) i;
      INSERT INTO workspaces VALUES ('ws-atlas', 'Atlas_100%'), ('ws-other', 'AtlasX100percent');
      INSERT INTO workspace_memberships SELECT id, 'ws-atlas' FROM users WHERE id <= 'user-0137';
      INSERT INTO workspace_memberships SELECT id, 'ws-other' FROM users;
    `);
    let queries = 0;
    const queryMock = mock.method(db, 'query', async (sql: string, params: unknown[]) => {
      queries++;
      return client.query(sql, params);
    });
    try {
      const read = async (query: Record<string, string>) => {
        const res = { body: undefined as any, status(code: number) { assert.equal(code, 200); return this; }, json(body: unknown) { this.body = body; return this; } };
        await listUsers({ query } as never, res as never, (err) => { if (err) throw err; });
        return res.body;
      };
      const ids: string[] = [];
      let cursor = '';
      do {
        const page = await read({ workspaceQuery: 'ATLAS_100%', limit: '25', ...(cursor ? { cursor } : {}) });
        assert.ok(page.items.length <= 25);
        ids.push(...page.items.map((user: any) => user.id));
        cursor = page.nextCursor || '';
      } while (cursor);
      assert.equal(queries, 6);
      assert.equal(ids.length, 137);
      assert.equal(new Set(ids).size, 137);
      assert.equal(ids.at(-1), 'user-0137');
      const combined = await read({ workspaceQuery: 's-ATLAS', emailVerified: 'true', q: 'person 12', limit: '100' });
      assert.deepEqual(combined.items.map((user: any) => user.id), ['user-0012', 'user-0120', 'user-0122', 'user-0124', 'user-0126', 'user-0128']);
      assert.equal(combined.items[0].workspaceMembershipCount, 2);
      assert.deepEqual((await read({ workspaceQuery: 'missing' })).items, []);
      assert.equal((await read({ limit: '25' })).items.length, 25);
    } finally { queryMock.mock.restore(); }
  } finally { await client.query('ROLLBACK'); await client.end(); }
});
