import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { addWorkspaceMember } from '../src/controllers/admin-controller.js';
import { db } from '../src/infra/db.js';
import { addExistingWorkspaceMember } from '../src/store/repository-admin.js';
import { repo } from '../src/store/repository.js';

afterEach(() => mock.restoreAll());

const adminReq = {
  admin: { tokenId: 'ops-primary', scopes: ['admin:*'], credential: { type: 'admin_token' } },
  header: () => undefined, ip: '127.0.0.1', socket: {}, res: { locals: { requestId: 'req-admin-test' } }
};

function response() {
  return { statusCode: 200, body: undefined as unknown, locals: { requestId: 'req-admin-test' },
    status(code: number) { this.statusCode = code; return this; }, json(payload: unknown) { this.body = payload; return this; } };
}

describe('admin membership dual audit', () => {
  it('correlates a protected admin record with a sanitized workspace record', async () => {
    let captured: any;
    mock.method(repo, 'getAdminWorkspace', async () => ({ id: 'workspace-1', name: 'Workspace', plan: { key: 'default', name: 'Default' } }));
    mock.method(repo, 'insertAdminAuditEvent', async (event) => event);
    mock.method(repo, 'addExistingWorkspaceMember', async (_workspaceId, _userId, _role, audit) => {
      captured = audit; return {
        status: 'created' as const,
        member: { userId: 'user-1', role: 'viewer' } as never,
        membershipGeneration: 1
      };
    });
    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    mock.method(db, 'query', async () => ({ rowCount: 1, rows: [] }));
    const res = response();
    await addWorkspaceMember({ ...adminReq, params: { workspaceId: 'workspace-1' }, body: { userId: 'user-1', role: 'viewer', reason: 'approved access request' } } as never, res as never, (err?: unknown) => { if (err) throw err; });
    assert.equal(captured.admin.adminTokenId, 'ops-primary');
    assert.equal(captured.workspace[0].actorTokenId, 'platform-admin');
    assert.equal(captured.admin.metadata.correlationId, captured.workspace[0].metadata.correlationId);
    assert.notEqual(captured.workspace[0].actorTokenId, captured.admin.adminTokenId);
  });

  it('returns retryable 503 after a committed membership activation failure and retries idempotently', async () => {
    mock.method(repo, 'getAdminWorkspace', async () => ({
      id: 'workspace-1', name: 'Workspace', plan: { key: 'default', name: 'Default' }
    }));
    mock.method(repo, 'insertAdminAuditEvent', async (event) => event);
    const add = mock.method(repo, 'addExistingWorkspaceMember', async () => ({
      status: 'created' as const,
      member: { userId: 'user-1', role: 'viewer' } as never,
      membershipGeneration: 2
    }));
    mock.method(db, 'query', async () => ({ rowCount: 1, rows: [] }));
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      detail: {
        code: 'MCP_USER_LIFECYCLE_TEARDOWN_FAILED',
        message: 'MCP user lifecycle teardown did not complete.',
        retryable: true
      }
    }), { status: 503, headers: { 'content-type': 'application/json' } }));
    const request = {
      ...adminReq,
      params: { workspaceId: 'workspace-1' },
      body: { userId: 'user-1', role: 'viewer', reason: 'approved access request' }
    };
    const failed = response();

    await addWorkspaceMember(request as never, failed as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(failed.statusCode, 503);
    assert.equal(
      (failed.body as { error: { code: string } }).error.code,
      'MCP_USER_LIFECYCLE_TEARDOWN_FAILED'
    );
    assert.equal(add.mock.callCount(), 1);
  });

  it('repairs an already-committed active membership on request retry', async () => {
    mock.method(repo, 'getAdminWorkspace', async () => ({
      id: 'workspace-1', name: 'Workspace', plan: { key: 'default', name: 'Default' }
    }));
    mock.method(repo, 'insertAdminAuditEvent', async (event) => event);
    mock.method(repo, 'addExistingWorkspaceMember', async () => ({ status: 'already_exists' as const }));
    mock.method(repo, 'getWorkspaceMember', async () => ({ userId: 'user-1', role: 'viewer' } as never));
    mock.method(db, 'query', async (sql: string) => {
      if (sql.includes('FROM workspace_member_mcp_lifecycle')) {
        return { rowCount: 1, rows: [{
          workspace_id: 'workspace-1', user_id: 'user-1', membership_generation: '2',
          status: 'active', reconciliation_status: 'failed'
        }] };
      }
      return { rowCount: 1, rows: [] };
    });
    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    const repaired = response();

    await addWorkspaceMember({
      ...adminReq,
      params: { workspaceId: 'workspace-1' },
      body: { userId: 'user-1', role: 'viewer', reason: 'retry activation' }
    } as never, repaired as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(repaired.statusCode, 200);
    assert.deepEqual(repaired.body, { userId: 'user-1', role: 'viewer' });
  });

  it('rolls back membership insertion when workspace audit persistence fails', async () => {
    const statements: string[] = [];
    const client = { query: async (sql: string) => {
      statements.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql === 'COMMIT') throw new Error('commit must not be reached');
      if (sql.includes('SELECT 1 FROM workspaces')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('SELECT * FROM users')) return { rowCount: 1, rows: [{ id: 'user-1', email: 'user@example.test', display_name: 'User', created_at: new Date() }] };
      if (sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: 'user-1' }] };
      if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships')) return { rowCount: 1, rows: [{ count: 0 }] };
      if (sql.includes('SELECT plan_key FROM workspaces')) return { rowCount: 1, rows: [{ plan_key: 'default' }] };
      if (sql.includes('FROM workspace_quota_overrides')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO workspace_memberships')) return { rowCount: 1, rows: [{ workspace_id: 'workspace-1', user_id: 'user-1', email: 'user@example.test', display_name: 'User', role: 'viewer', source: 'internal', created_at: new Date(), updated_at: new Date() }] };
      if (sql.includes('INSERT INTO admin_audit_events')) return { rowCount: 1, rows: [{ id: 'admin-event', admin_token_id: 'ops-primary', action: 'admin.workspace.member.add', outcome: 'success', workspace_id: 'workspace-1', subject_type: 'user', subject_id: 'user-1', request_id: 'request-1', metadata: {}, occurred_at: new Date() }] };
      if (sql.includes('INSERT INTO workspace_audit_events')) throw new Error('workspace audit unavailable');
      throw new Error(`Unexpected query: ${sql}`);
    }, release: () => undefined };
    mock.method(db, 'connect', async () => client);
    await assert.rejects(() => addExistingWorkspaceMember('workspace-1', 'user-1', 'viewer', {
      admin: { adminTokenId: 'ops-primary', action: 'admin.workspace.member.add', outcome: 'success', requestId: 'request-1' },
      workspace: [{ workspaceId: 'workspace-1', category: 'membership', eventType: 'workspace.member.added.v1', operation: 'write', actorType: 'admin_token', actorTokenId: 'platform-admin', objectType: 'member', summary: 'Granted by platform administrator' }]
    }), /workspace audit unavailable/);
    assert(statements.includes('ROLLBACK'));
    assert.equal(statements.includes('COMMIT'), false);
  });
});
