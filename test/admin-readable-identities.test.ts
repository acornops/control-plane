import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import { db } from '../src/infra/db.js';
import { listAdminAuditEvents } from '../src/store/repository-admin-audit.js';
import { listAdminWorkspaces } from '../src/store/repository-admin-workspaces.js';

afterEach(() => {
  mock.restoreAll();
});

test('returns readable governance labels without replacing immutable IDs', async () => {
  const queries: string[] = [];
  mock.method(db, 'query', async (sql: string) => {
    queries.push(sql);
    if (sql.includes('FROM workspaces w')) {
      return {
        rowCount: 1,
        rows: [{
          id: 'workspace-1',
          name: 'Atlas Research',
          plan_key: 'default',
          created_by: 'user-1',
          created_by_display_name: 'Maya Chen',
          created_by_email: 'maya@example.test',
          created_at: '2026-01-01T00:00:00.000Z',
          current_user_role: 'owner',
          cluster_count: 0,
          virtual_machine_count: 0,
          member_count: 1,
          lifecycle_status: 'active'
        }]
      };
    }
    return {
      rowCount: 1,
      rows: [{
        id: '00000000-0000-4000-8000-000000000001',
        action: 'admin.workspace.detail.read',
        outcome: 'success',
        workspace_id: 'workspace-1',
        workspace_name: 'Atlas Research',
        request_id: 'request-1',
        metadata: {},
        occurred_at: '2026-01-01T00:00:00.000Z'
      }]
    };
  });

  const workspaces = await listAdminWorkspaces();
  const auditEvents = await listAdminAuditEvents();

  assert.equal(workspaces.items[0].createdBy, 'user-1');
  assert.equal(workspaces.items[0].createdByDisplayName, 'Maya Chen');
  assert.equal(workspaces.items[0].createdByEmail, 'maya@example.test');
  assert.equal(auditEvents.items[0].workspaceId, 'workspace-1');
  assert.equal(auditEvents.items[0].workspaceName, 'Atlas Research');
  assert.match(queries[0], /LEFT JOIN users creator ON creator\.id = w\.created_by/);
  assert.match(queries[1], /LEFT JOIN workspaces w ON w\.id = a\.workspace_id/);
});
