import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  deleteWorkspaceMember,
  addWorkspaceMember,
  listAdminAuditEvents,
  listUsers,
  listWorkspaceAuditEvents,
  listWorkspaces,
  patchWorkspacePlan,
  patchWorkspaceQuotas,
  restoreWorkspace,
  suspendWorkspace
} from '../src/controllers/admin-controller.js';
import { listRuns, listTargets } from '../src/controllers/admin-target-run-controller.js';
import { addExistingWorkspaceMember, listAdminWorkspaces } from '../src/store/repository-admin.js';
import { repo } from '../src/store/repository.js';
import { WorkspacePolicyError } from '../src/types/workspace-policy.js';
import { db } from '../src/infra/db.js';
import { adminReasonOnlySchema, adminWorkspacePlanPatchSchema, adminWorkspaceRestoreSchema, adminWorkspaceSuspendSchema } from '../src/types/contracts.js';
beforeEach(() => { mock.method(repo, 'insertAdminAuditEvent', async event => event); });
afterEach(() => {
  mock.restoreAll();
});

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    locals: { requestId: 'req-admin-test' },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload?: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    }
  };
}

const adminReq = {
  admin: { tokenId: 'platform-admin-console', scopes: ['admin:*'], credential: { type: 'admin_token' } },
  header: () => undefined,
  ip: '127.0.0.1',
  socket: {},
  res: { locals: { requestId: 'req-admin-test' } }
};

describe('admin controller security invariants', () => {
  it('returns transactional workspace confirmation errors to callers', async () => {
    mock.method(repo, 'mutateWorkspacePolicy', async () => { throw new WorkspacePolicyError('VALIDATION_ERROR', 400, 'Workspace name does not match'); });
    for (const handler of [suspendWorkspace, restoreWorkspace]) {
      const res = response();
      await handler({ ...adminReq, params: { workspaceId: 'workspace-1' }, body: { workspaceName: 'atlas research', reason: 'support ticket' } } as never, res as never, (err?: unknown) => { if (err) throw err; });
      assert.equal(res.statusCode, 400);
      assert.equal((res.body as { error: { message: string } }).error.message, 'Workspace name does not match');
    }
  });

  it('returns committed lifecycle responses and passes human audit identity into the transaction', async () => {
    const active = { id: 'workspace-1', name: 'Atlas Research', lifecycleStatus: 'active' };
    const suspended = { ...active, lifecycleStatus: 'suspended' };
    mock.method(repo, 'mutateWorkspacePolicy', async (input) => {
      assert.equal(input.audit.adminTokenId, 'platform-admin-console');
      assert.equal(input.audit.reason, 'support ticket');
      return { before: active, after: input.operation === 'suspend' ? suspended : active };
    });
    for (const [handler, status] of [[suspendWorkspace, 'suspended'], [restoreWorkspace, 'active']] as const) {
      const res = response();
      await handler({ ...adminReq, params: { workspaceId: 'workspace-1' }, body: { workspaceName: 'Atlas Research', reason: 'support ticket' } } as never, res as never, (err?: unknown) => { if (err) throw err; });
      assert.equal(res.statusCode, 200);
      assert.equal((res.body as { after: { lifecycleStatus: string } }).after.lifecycleStatus, status);
    }
  });

  it('keeps workspace-name confirmation whitespace significant', () => {
    assert.equal(adminWorkspaceSuspendSchema.safeParse({ workspaceName: 'Atlas Research', reason: 'support hold' }).success, true);
    assert.equal(adminWorkspaceRestoreSchema.safeParse({ workspaceName: 'Atlas Research', reason: 'support hold cleared' }).success, true);
    assert.equal(adminWorkspaceRestoreSchema.safeParse({ reason: 'legacy support hold cleared' }).success, true);
    assert.equal(adminWorkspaceSuspendSchema.safeParse({ workspaceName: ' Atlas Research ', reason: 'support hold' }).success, true);
    assert.notEqual(' Atlas Research ', 'Atlas Research');
  });

  it('returns transactional over-limit failures for both plan and quota changes', async () => {
    mock.method(repo, 'mutateWorkspacePolicy', async () => { throw new WorkspacePolicyError('VALIDATION_ERROR', 400, 'Current workspace usage exceeds target policy limits'); });
    for (const handler of [patchWorkspacePlan, patchWorkspaceQuotas]) {
      const res = response();
      await handler({ ...adminReq, params: { workspaceId: 'workspace-1' }, body: { reason: 'support ticket' } } as never, res as never, (err?: unknown) => { if (err) throw err; });
      assert.equal(res.statusCode, 400);
    }
  });

  it('forwards transactional audit failures without a successful mutation response', async () => {
    mock.method(repo, 'mutateWorkspacePolicy', async () => { throw new Error('audit unavailable'); });
    const res = response();
    let forwarded: unknown;
    await patchWorkspacePlan({ ...adminReq, params: { workspaceId: 'workspace-1' }, body: { planKey: 'default', reason: 'support ticket' } } as never, res as never, (error?: unknown) => { forwarded = error; });
    assert(forwarded instanceof Error);
    assert.equal(forwarded.message, 'audit unavailable');
    assert.equal(res.body, undefined);
  });

  it('requires a version for receipt-bearing mutations even with broad credentials', async () => {
    mock.method(repo, 'mutateWorkspacePolicy', async () => { throw new Error('must not mutate'); });
    const res = response();
    await restoreWorkspace({ ...adminReq, params: { workspaceId: 'workspace-1' }, body: { requestId: 'expired-restore', reason: 'old restore' } } as never, res as never, (error?: unknown) => { if (error) throw error; });
    assert.equal(res.statusCode, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, 'POLICY_PRECONDITION_REQUIRED');
  });

  it('requires narrow machine preconditions and explicit external hold source', async () => {
    mock.method(repo, 'mutateWorkspacePolicy', async () => { throw new Error('must not mutate'); });
    for (const [body, expectedStatus] of [[{ reason: 'support ticket', source: 'external' }, 400], [{ reason: 'support ticket', requestId: 'r1', expectedPolicyVersion: 0 }, 403], [{ reason: 'support ticket', requestId: 'r2', expectedPolicyVersion: 0, source: 'admin' }, 403]] as const) {
      const res = response();
      await suspendWorkspace({ ...adminReq, admin: { ...adminReq.admin, scopes: ['admin:workspace:external-hold:write'] }, params: { workspaceId: 'workspace-1' }, body } as never, res as never, (error?: unknown) => { if (error) throw error; });
      assert.equal(res.statusCode, expectedStatus);
    }
  });

  it('rejects replacing the last owner with the same member being removed', async () => {
    let replaceCalled = false;
    mock.method(repo, 'getWorkspaceMember', async () => ({ userId: 'user-1', role: 'owner' }));
    mock.method(repo, 'deleteExistingWorkspaceMember', async () => ({ status: 'last_owner' }));
    mock.method(repo, 'replaceLastOwnerAndDeleteMember', async () => {
      replaceCalled = true;
      return { status: 'deleted' };
    });
    const req = {
      ...adminReq,
      params: { workspaceId: 'workspace-1', userId: 'user-1' },
      body: { replacementOwnerUserId: 'user-1', reason: 'support ticket TEST-2' }
    };
    const res = response();

    await deleteWorkspaceMember(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 400);
    assert.equal(replaceCalled, false);
  });

  it('enforces user and workspace quotas before admin member insertion', async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
        if (sql.includes('SELECT 1 FROM workspaces')) return { rowCount: 1, rows: [{ exists: 1 }] };
        if (sql.includes('SELECT * FROM users')) {
          return { rowCount: 1, rows: [{ id: 'user-1', email: 'user@example.test', display_name: 'User', created_at: '2026-06-01T00:00:00.000Z' }] };
        }
        if (sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: 'user-1' }] };
        if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships') && sql.includes('user_id')) return { rowCount: 1, rows: [{ count: 1 }] };
        if (sql.includes('SELECT plan_key FROM workspaces') && sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ plan_key: 'default' }] };
        if (sql.includes('FROM workspace_quota_overrides')) return { rowCount: 0, rows: [] };
        if (sql.includes('COUNT(*)::int AS count FROM workspace_memberships') && sql.includes('workspace_id')) return { rowCount: 1, rows: [{ count: 1 }] };
        if (sql.includes('INSERT INTO workspace_memberships')) {
          return {
            rowCount: 1,
            rows: [{
              workspace_id: 'workspace-1',
              user_id: 'user-1',
              email: 'user@example.test',
              display_name: 'User',
              role: 'viewer',
              source: 'internal',
              created_at: '2026-06-01T00:00:00.000Z',
              updated_at: '2026-06-01T00:00:00.000Z'
            }]
          };
        }
        if (sql.includes('FROM workspace_member_mcp_lifecycle')) return { rowCount: 1, rows: [{
          workspace_id: 'workspace-1', user_id: 'user-1', membership_generation: '1', status: 'active', reconciliation_status: 'pending' }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
      release: () => undefined
    };
    mock.method(db, 'connect', async () => client);
    const result = await addExistingWorkspaceMember('workspace-1', 'user-1', 'viewer');

    assert.equal(result.status, 'created');
    assert(statements.findIndex((sql) => sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) <
      statements.findIndex((sql) => sql.includes('INSERT INTO workspace_memberships')));
    assert(statements.findIndex((sql) => sql.includes('SELECT plan_key FROM workspaces') && sql.includes('FOR UPDATE')) <
      statements.findIndex((sql) => sql.includes('INSERT INTO workspace_memberships')));
  });

  it('does not create a missing user when the target workspace is already at member quota', async () => {
    let createUserCalled = false;
    mock.method(repo, 'getAdminWorkspace', async () => ({
      id: 'workspace-1',
      name: 'Workspace',
      plan: { key: 'default', name: 'Default' },
      quotaOverrides: { members: 2, kubernetesClusters: null, virtualMachines: null }
    }));
    mock.method(repo, 'findUserByEmail', async () => null);
    mock.method(repo, 'countWorkspaceUsage', async () => ({ members: 2, kubernetesClusters: 0, virtualMachines: 0 }));
    mock.method(repo, 'createVerifiedInternalUser', async () => {
      createUserCalled = true;
      return null;
    });
    const req = {
      ...adminReq,
      params: { workspaceId: 'workspace-1' },
      body: { email: 'new@example.test', createUserIfMissing: true, role: 'viewer', reason: 'support ticket TEST-4' }
    };
    const res = response();

    await addWorkspaceMember(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 409);
    assert.equal(createUserCalled, false);
  });

  it('filters admin workspace over-limit searches against plan or override limits', async () => {
    const queries: string[] = [];
    mock.method(db, 'query', async (sql: string) => {
      queries.push(sql);
      return { rowCount: 0, rows: [] };
    });

    await listAdminWorkspaces({ overLimit: true });
    await listAdminWorkspaces({ overLimit: false });

    assert.match(queries[0], /COALESCE\(qo\.members, \(CASE w\.plan_key WHEN 'default' THEN 100 ELSE 2147483647 END\)\)/);
    assert.match(queries[0], /> COALESCE\(qo\.kubernetes_clusters/);
    assert.match(queries[0], /\n\s+OR COALESCE\(virtual_machine_counts/);
    assert.match(queries[1], /<= COALESCE\(qo\.members/);
    assert.match(queries[1], /\n\s+AND COALESCE\(virtual_machine_counts/);
  });

  it('rejects invalid admin boolean query filters instead of widening searches', async () => {
    const cases = [
      { handler: listWorkspaces, req: { query: { overLimit: 'sometimes' } } },
      { handler: listUsers, req: { query: { emailVerified: 'sometimes' } } },
      { handler: listRuns, req: { query: { active: 'sometimes' } } }
    ];
    for (const item of cases) {
      const res = response();
      await item.handler({ ...adminReq, ...item.req } as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });
      assert.equal(res.statusCode, 400);
    }
  });

  it('rejects invalid admin audit and run query filters instead of widening or erroring late', async () => {
    const cases = [
      { handler: listWorkspaces, req: { query: { createdAfter: 'not-a-date' } } },
      { handler: listWorkspaces, req: { query: { createdAfter: '2026-06-02', createdBefore: '2026-06-01' } } },
      { handler: listUsers, req: { query: { authMethod: 'magic-link' } } },
      { handler: listTargets, req: { query: { lastSeenBefore: 'not-a-date' } } },
      { handler: listTargets, req: { query: { lastSeenAfter: '2026-06-02', lastSeenBefore: '2026-06-01' } } },
      { handler: listAdminAuditEvents, req: { query: { outcome: 'maybe' } } },
      { handler: listAdminAuditEvents, req: { query: { actionGroup: 'everything' } } },
      { handler: listAdminAuditEvents, req: { query: { action: 'admin.workspace.suspend', actionGroup: 'workspace_status_modified' } } },
      { handler: listAdminAuditEvents, req: { query: { from: 'not-a-date' } } },
      { handler: listWorkspaceAuditEvents, req: { query: { workspaceId: 'workspace-1', category: 'everything' } } },
      { handler: listWorkspaceAuditEvents, req: { query: { workspaceId: 'workspace-1', from: '2026-06-02', to: '2026-06-01' } } },
      { handler: listRuns, req: { query: { status: 'mostly_running' } } },
      { handler: listRuns, req: { query: { olderThanSeconds: 'eventually' } } }
    ];
    for (const item of cases) {
      const res = response();
      await item.handler({ ...adminReq, ...item.req } as never, res as never, (err?: unknown) => {
        if (err) throw err;
      });
      assert.equal(res.statusCode, 400);
    }
  });
  it('expands allowlisted admin audit action groups without losing exact action records', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    mock.method(repo, 'insertAdminAuditEvent', async (event) => event);
    mock.method(repo, 'listAdminAuditEvents', async (options) => {
      capturedOptions = options as Record<string, unknown>;
      return { items: [] };
    });
    const res = response();
    await listAdminAuditEvents({ ...adminReq, query: { actionGroup: 'workspace_access_modified' } } as never, res as never, (err?: unknown) => { if (err) throw err; });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(capturedOptions?.actionFilters, [{
      actions: ['admin.workspace.member.add', 'admin.workspace.member.add.request', 'admin.workspace.member.delete', 'admin.workspace.member.delete.request', 'admin.workspace.member.role.update', 'admin.workspace.member.role.update.request', 'admin.member.role.update', 'admin.member.role.update.request']
    }]);
    assert.equal(capturedOptions?.actionGroup, 'workspace_access_modified');
  });
  it('normalizes workspace name-or-ID audit queries into the cursor-bound repository options', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    mock.method(repo, 'listAdminAuditEvents', async (options) => {
      capturedOptions = options as Record<string, unknown>;
      return { items: [] };
    });
    const res = response();
    await listAdminAuditEvents({
      ...adminReq,
      query: { workspaceQuery: '  Atlas Research  ' }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal(capturedOptions?.workspaceQuery, 'Atlas Research');
    assert.equal(typeof capturedOptions?.signature, 'string');
  });

  it('uses objectType for admin workspace audit searches', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    mock.method(repo, 'insertAdminAuditEvent', async (event) => event);
    mock.method(repo, 'listWorkspaceAuditEvents', async (_workspaceId, options) => {
      capturedOptions = options as Record<string, unknown>;
      return { items: [], nextCursor: undefined };
    });
    const res = response();

    await listWorkspaceAuditEvents({
      ...adminReq,
      query: {
        workspaceId: 'workspace-1',
        category: 'target',
        eventType: 'target.registered.v1',
        actorUserId: 'user-1',
        objectType: 'kubernetes_cluster'
      }
    } as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.equal(capturedOptions?.objectType, 'kubernetes_cluster');
    assert.equal(capturedOptions?.targetType, undefined);
  });

  it('rejects unknown fields in mutating admin bodies', () => {
    assert.equal(adminReasonOnlySchema.safeParse({ reason: 'support ticket TEST-5', agentKey: 'secret' }).success, false);
    assert.equal(adminWorkspacePlanPatchSchema.safeParse({
      planKey: 'default',
      reason: 'support ticket TEST-6',
      allowOverLimit: true
    }).success, false);
  });
});
