import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client } from 'pg';
import { createApp } from '../src/app.js';
import { hashAdminToken } from '../src/auth/admin-token.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
import { closeRedis } from '../src/infra/redis.js';

test('admin summaries and lifecycle pages remain bounded and scoped on PostgreSQL', { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async (t) => {
  const client = new Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await client.connect();
  const old = { enabled: config.CONTROL_PLANE_ADMIN_API_ENABLED, human: config.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED, descriptors: config.ADMIN_TOKEN_DESCRIPTORS };
  config.CONTROL_PLANE_ADMIN_API_ENABLED = true;
  config.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED = false;
  config.ADMIN_TOKEN_DESCRIPTORS = [
    { id: 'workspaces', sha256: hashAdminToken('workspace-test-token'), scopes: ['admin:workspace:read'], enabled: true },
    { id: 'users', sha256: hashAdminToken('user-test-token'), scopes: ['admin:user:read'], enabled: true }
  ];
  await client.query('BEGIN');
  await client.query(`
    CREATE TEMP TABLE workspaces (LIKE public.workspaces INCLUDING DEFAULTS) ON COMMIT DROP;
    CREATE TEMP TABLE users (LIKE public.users INCLUDING DEFAULTS) ON COMMIT DROP;
    CREATE TEMP TABLE workspace_quota_overrides (LIKE public.workspace_quota_overrides) ON COMMIT DROP;
    CREATE TEMP TABLE workspace_memberships (LIKE public.workspace_memberships INCLUDING DEFAULTS) ON COMMIT DROP;
    CREATE TEMP TABLE user_password_credentials (user_id text, last_login_at timestamptz) ON COMMIT DROP;
    CREATE TEMP TABLE user_federated_identities (user_id text, provider text, last_login_at timestamptz) ON COMMIT DROP;
    CREATE TEMP TABLE targets (workspace_id text, target_type text) ON COMMIT DROP;
    INSERT INTO users(id,email,display_name,email_verified_at) SELECT 'user-'||i, 'u'||i||'@example.test', 'User '||i, CASE WHEN i%2=0 THEN NOW() END FROM generate_series(1,1000) i;
    INSERT INTO workspaces(id,name,created_by,lifecycle_status,created_at) SELECT 'ws-'||lpad(i::text,4,'0'), 'Workspace '||lpad(i::text,4,'0'), 'user-1', CASE WHEN i<=137 THEN 'suspended' ELSE 'active' END, '2026-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1,1000) i;
    INSERT INTO targets VALUES ('ws-0001','kubernetes'),('ws-0001','kubernetes'),('ws-0001','kubernetes'),('ws-0001','virtual_machine'),('ws-0002','virtual_machine'),('ws-0002','virtual_machine'),('ws-0003','kubernetes');
    INSERT INTO workspace_memberships(workspace_id,user_id,role,source,created_at) SELECT 'ws-0001', 'user-'||i, 'member', 'internal', '2026-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1,137) i;
  `);
  let queued = Promise.resolve();
  t.mock.method(db, 'query', (sql: string, params: unknown[]) => {
    const result = queued.then(() => client.query(sql, params));
    queued = result.then(() => undefined, () => undefined);
    return result;
  });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/v1`;
  const get = (path: string, token = 'workspace-test-token') => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  try {
    const summary = await get('/workspaces/summary');
    assert.equal(summary.status, 200);
    assert.deepEqual(await summary.json(), { workspaceCount: 1000, suspendedWorkspaceCount: 137, kubernetesCount: 4, virtualMachineCount: 3,
      environmentLeaders: [
        { id: 'ws-0001', name: 'Workspace 0001', clusterCount: 3, virtualMachineCount: 1 },
        { id: 'ws-0002', name: 'Workspace 0002', clusterCount: 0, virtualMachineCount: 2 },
        { id: 'ws-0003', name: 'Workspace 0003', clusterCount: 1, virtualMachineCount: 0 }
      ] });
    assert.deepEqual(await (await get('/users/summary', 'user-test-token')).json(), { userCount: 1000, verifiedUserCount: 500 });
    assert.equal((await get('/users/summary')).status, 403);
    assert.equal((await get('/workspaces/summary', 'user-test-token')).status, 403);
    const ids: string[] = [];
    let cursor = '';
    let firstCursor = '';
    do {
      const response = await get(`/workspaces?limit=25&lifecycleStatus=suspended${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(response.status, 200);
      const page = await response.json();
      assert.ok(page.items.length <= 25);
      assert.ok(page.items.every((item: { lifecycleStatus: string }) => item.lifecycleStatus === 'suspended'));
      ids.push(...page.items.map((item: { id: string }) => item.id));
      assert.ok(ids.length <= 150, 'cursor traversal must advance through microsecond timestamps');
      cursor = page.nextCursor || '';
      firstCursor ||= cursor;
    } while (cursor);
    assert.equal(ids.length, 137);
    assert.equal(new Set(ids).size, 137);
    assert.equal((await get(`/workspaces?lifecycleStatus=active&cursor=${encodeURIComponent(firstCursor)}`)).status, 400);
    assert.equal((await get('/workspaces?lifecycleStatus=invalid')).status, 400);
    assert.equal((await get('/workspaces?lifecycleStatus=active&lifecycleStatus=suspended')).status, 400);
    const idMatch = await (await get('/workspaces?q=WS-0001&limit=8')).json();
    assert.deepEqual(idMatch.items.map((item: { id: string }) => item.id), ['ws-0001']);
    for (const [path, expected, idField] of [['/users', 1000, 'id'], ['/workspaces/ws-0001/members', 137, 'userId']] as const) {
      const all: string[] = [];
      let next = '';
      do {
        const page = await (await get(`${path}?limit=25${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, 'user-test-token')).json();
        assert.ok(page.items.length <= 25);
        all.push(...page.items.map((item: Record<string, string>) => item[idField]));
        assert.ok(all.length <= expected, `${path} must advance through microsecond timestamps`);
        next = page.nextCursor || '';
      } while (next);
      assert.equal(all.length, expected);
      assert.equal(new Set(all).size, expected);
    }
    const detail = await (await get('/users/user-1', 'user-test-token')).json();
    assert.equal(detail.memberships[0].workspaceName, 'Workspace 0001');
    assert.equal(detail.memberships[0].workspaceLifecycleStatus, 'suspended');
    await client.query('DELETE FROM targets');
    const zeroFootprint = await (await get('/workspaces/summary')).json();
    assert.equal(zeroFootprint.kubernetesCount, 0);
    assert.equal(zeroFootprint.virtualMachineCount, 0);
    assert.equal(zeroFootprint.environmentLeaders.length, 3);
    assert.ok(zeroFootprint.environmentLeaders.every((item: { clusterCount: number; virtualMachineCount: number }) => item.clusterCount === 0 && item.virtualMachineCount === 0));
    await client.query('DELETE FROM workspaces; DELETE FROM users');
    assert.deepEqual(await (await get('/workspaces/summary')).json(), { workspaceCount: 0, suspendedWorkspaceCount: 0, kubernetesCount: 0, virtualMachineCount: 0, environmentLeaders: [] });
    assert.deepEqual(await (await get('/users/summary', 'user-test-token')).json(), { userCount: 0, verifiedUserCount: 0 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await client.query('ROLLBACK');
    await client.end();
    await closeRedis();
    config.CONTROL_PLANE_ADMIN_API_ENABLED = old.enabled;
    config.CONTROL_PLANE_ADMIN_HUMAN_AUTH_REQUIRED = old.human;
    config.ADMIN_TOKEN_DESCRIPTORS = old.descriptors;
  }
});
