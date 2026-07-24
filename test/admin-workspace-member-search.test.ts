import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { listWorkspaceMembers } from '../src/controllers/admin-workspace-member-search-controller.js';
import { db } from '../src/infra/db.js';
import { listAdminWorkspaceMembers } from '../src/store/repository-admin.js';
import { repo } from '../src/store/repository.js';

afterEach(() => {
  mock.restoreAll();
});

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    locals: { requestId: 'req-admin-member-search-test' },
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

const adminReq = {
  admin: { tokenId: 'ops-primary', scopes: ['admin:*'], credential: { type: 'admin_token' } },
  header: () => undefined,
  ip: '127.0.0.1',
  socket: {},
  res: { locals: { requestId: 'req-admin-member-search-test' } }
};

describe('admin workspace member search', () => {
  it('returns an authoritative paginated page and audits the high-risk read', async () => {
    mock.method(repo, 'getAdminWorkspace', async () => ({
      id: 'workspace-1',
      name: 'Atlas Research',
      plan: { key: 'default', name: 'Default' },
      lifecycleStatus: 'active'
    }));
    let capturedOptions: Record<string, unknown> | undefined;
    mock.method(repo, 'listAdminWorkspaceMembers', async (options) => {
      capturedOptions = options as Record<string, unknown>;
      return { items: [] };
    });
    const events: Array<Record<string, unknown>> = [];
    mock.method(repo, 'insertAdminAuditEvent', async (event) => {
      events.push(event as unknown as Record<string, unknown>);
      return event;
    });
    const res = response();

    await listWorkspaceMembers({ ...adminReq, params: { workspaceId: 'workspace-1' }, query: { limit: '25' } } as never, res as never, (err?: unknown) => { if (err) throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(capturedOptions?.workspaceId, 'workspace-1');
    assert.equal(capturedOptions?.limit, 25);
    assert.equal(events[0].action, 'admin.workspace.members.search');
    assert.deepEqual(events[0].metadata, { highRiskRead: true });
  });

  it('pages rows with a stable created-at and user-id cursor', async () => {
    let observedSql = '';
    let observedParams: unknown[] = [];
    mock.method(db, 'query', async (sql: string, params?: unknown[]) => {
      observedSql = sql;
      observedParams = params || [];
      return { rowCount: 0, rows: [] };
    });

    await listAdminWorkspaceMembers({
      workspaceId: 'workspace-1',
      limit: 25,
      cursor: { createdAt: '2026-01-01T00:00:00.000Z', userId: 'user-2' },
      signature: 'member-query-signature'
    });

    assert.match(observedSql, /INNER JOIN users u ON u\.id = m\.user_id/);
    assert.match(observedSql, /\(m\.created_at, m\.user_id\) > \(\$3::timestamptz, \$4::text\)/);
    assert.match(observedSql, /ORDER BY m\.created_at ASC, m\.user_id ASC/);
    assert.match(observedSql, /LIMIT \$2/);
    assert.deepEqual(observedParams, ['workspace-1', 26, '2026-01-01T00:00:00.000Z', 'user-2']);
  });
});
