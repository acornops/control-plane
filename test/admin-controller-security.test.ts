import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
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
import { db } from '../src/infra/db.js';
import { adminReasonOnlySchema, adminWorkspacePlanPatchSchema, adminWorkspaceRestoreSchema, adminWorkspaceSuspendSchema } from '../src/types/contracts.js';

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
  it('requires an exact workspace name before lifecycle transitions', async () => {
    let transitionCalled = false;
    mock.method(repo, 'getAdminWorkspace', async () => ({
      id: 'workspace-1',
      name: 'Atlas Research',
      plan: { key: 'default', name: 'Default' },
      lifecycleStatus: 'active'
    }));
    mock.method(repo, 'transitionWorkspaceLifecycle', async () => {
      transitionCalled = true;
      return { status: 'state_conflict' as const };
    });
    mock.method(repo, 'insertAdminAuditEvent', async (event) => event);
    const req = {
      ...adminReq,
      params: { workspaceId: 'workspace-1' },
      body: { workspaceName: 'atlas research', reason: 'support ticket TEST-LIFE-1' }
    };
    const res = response();

    await suspendWorkspace(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 400);
    assert.equal(transitionCalled, false);

    const restoreRes = response();
    await restoreWorkspace({ ...req, body: { workspaceName: 'atlas research', reason: 'support ticket TEST-LIFE-1B' } } as never, restoreRes as never, (err?: unknown) => { if (err) throw err; });
    assert.equal(restoreRes.statusCode, 400);
    assert.equal(transitionCalled, false);
  });

  it('suspends and restores workspace access through audited lifecycle transitions', async () => {
    const active = { id: 'workspace-1', name: 'Atlas Research', plan: { key: 'default', name: 'Default' }, lifecycleStatus: 'active' as const };
    const suspended = { ...active, lifecycleStatus: 'suspended' as const, suspendedAt: '2026-07-17T00:00:00.000Z' };
    let current = active as typeof active | typeof suspended;
    mock.method(repo, 'getAdminWorkspace', async () => current);
    mock.method(repo, 'transitionWorkspaceLifecycle', async (_id, expected, next) => {
      assert.equal(current.lifecycleStatus, expected);
      current = next === 'suspended' ? suspended : active;
      return { status: 'updated' as const, workspace: current as never };
    });
    const adminEvents: Array<Record<string, unknown>> = [];
    const workspaceEvents: Array<Record<string, unknown>> = [];
    mock.method(repo, 'insertAdminAuditEvent', async (event) => { adminEvents.push(event as unknown as Record<string, unknown>); return event; });
    mock.method(repo, 'insertWorkspaceAuditEvent', async (event) => { workspaceEvents.push(event as unknown as Record<string, unknown>); return event as never; });

    const suspendRes = response();
    await suspendWorkspace({ ...adminReq, params: { workspaceId: 'workspace-1' }, body: { workspaceName: 'Atlas Research', reason: 'support ticket TEST-LIFE-2' } } as never, suspendRes as never, (err?: unknown) => { if (err) throw err; });
    assert.equal(suspendRes.statusCode, 200);
    assert.equal((suspendRes.body as { after: { lifecycleStatus: string } }).after.lifecycleStatus, 'suspended');

    const restoreRes = response();
    await restoreWorkspace({ ...adminReq, params: { workspaceId: 'workspace-1' }, body: { workspaceName: 'Atlas Research', reason: 'support ticket TEST-LIFE-3' } } as never, restoreRes as never, (err?: unknown) => { if (err) throw err; });
    assert.equal(restoreRes.statusCode, 200);
    assert.equal((restoreRes.body as { after: { lifecycleStatus: string } }).after.lifecycleStatus, 'active');
    const completedAdminEvents = adminEvents.filter((event) => !(event.action as string).endsWith('.request'));
    assert.equal(completedAdminEvents.length, 2);
    assert.equal(workspaceEvents.length, 2);
    for (let index = 0; index < 2; index += 1) {
      assert.equal(workspaceEvents[index].actorTokenId, 'platform-admin');
      const adminCorrelation = (completedAdminEvents[index].metadata as Record<string, unknown>).correlationId;
      const workspaceCorrelation = (workspaceEvents[index].metadata as Record<string, unknown>).correlationId;
      assert.equal(typeof adminCorrelation, 'string');
      assert.equal(adminCorrelation, workspaceCorrelation);
      assert.equal('ticketRef' in (workspaceEvents[index].metadata as Record<string, unknown>), false);
    }
  });

  it('keeps workspace-name confirmation whitespace significant', () => {
    assert.equal(adminWorkspaceSuspendSchema.safeParse({ workspaceName: 'Atlas Research', reason: 'support hold' }).success, true);
    assert.equal(adminWorkspaceRestoreSchema.safeParse({ workspaceName: 'Atlas Research', reason: 'support hold cleared' }).success, true);
    assert.equal(adminWorkspaceRestoreSchema.safeParse({ reason: 'legacy support hold cleared' }).success, true);
    assert.equal(adminWorkspaceSuspendSchema.safeParse({ workspaceName: ' Atlas Research ', reason: 'support hold' }).success, true);
    assert.notEqual(' Atlas Research ', 'Atlas Research');
  });

  it('rejects over-limit plan changes even when callers request an override', async () => {
    let updatePlanCalled = false;
    mock.method(repo, 'getAdminWorkspace', async () => ({
      id: 'workspace-1',
      name: 'Workspace',
      plan: { key: 'enterprise', name: 'Enterprise' },
      quotaOverrides: { members: null, kubernetesClusters: null, virtualMachines: null }
    }));
    mock.method(repo, 'countWorkspaceUsage', async () => ({ members: 101, kubernetesClusters: 2, virtualMachines: 1 }));
    mock.method(repo, 'updateWorkspacePlan', async () => {
      updatePlanCalled = true;
      return null;
    });
    mock.method(repo, 'insertAdminAuditEvent', async (event) => event);
    const req = {
      ...adminReq,
      params: { workspaceId: 'workspace-1' },
      body: { planKey: 'default', reason: 'support ticket TEST-0', allowOverLimit: true }
    };
    const res = response();

    await patchWorkspacePlan(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 400);
    assert.equal(updatePlanCalled, false);
  });

  it('rejects quota override changes that would put current usage over limit before mutation', async () => {
    let setOverridesCalled = false;
    mock.method(repo, 'getAdminWorkspace', async () => ({
      id: 'workspace-1',
      name: 'Workspace',
      plan: { key: 'default', name: 'Default' },
      quotaOverrides: { members: null, kubernetesClusters: null, virtualMachines: null }
    }));
    mock.method(repo, 'countWorkspaceUsage', async () => ({ members: 5, kubernetesClusters: 2, virtualMachines: 1 }));
    mock.method(repo, 'setWorkspaceQuotaOverrides', async () => {
      setOverridesCalled = true;
      return null;
    });
    mock.method(repo, 'insertAdminAuditEvent', async (event) => event);
    const req = {
      ...adminReq,
      params: { workspaceId: 'workspace-1' },
      body: { quotas: { members: 4 }, reason: 'support ticket TEST-1' }
    };
    const res = response();

    await patchWorkspaceQuotas(req as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 400);
    assert.equal(setOverridesCalled, false);
  });

  it('blocks plan mutations when the preflight admin audit cannot be written', async () => {
    let updatePlanCalled = false;
    mock.method(repo, 'getAdminWorkspace', async () => ({
      id: 'workspace-1',
      name: 'Workspace',
      plan: { key: 'default', name: 'Default' },
      quotaOverrides: { members: null, kubernetesClusters: null, virtualMachines: null }
    }));
    mock.method(repo, 'countWorkspaceUsage', async () => ({ members: 1, kubernetesClusters: 1, virtualMachines: 1 }));
    mock.method(repo, 'insertAdminAuditEvent', async () => {
      throw new Error('audit unavailable');
    });
    mock.method(repo, 'updateWorkspacePlan', async () => {
      updatePlanCalled = true;
      return null;
    });
    const req = {
      ...adminReq,
      params: { workspaceId: 'workspace-1' },
      body: { planKey: 'default', reason: 'support ticket TEST-3' }
    };
    const res = response();
    let forwarded: unknown;

    await patchWorkspacePlan(req as never, res as never, (err?: unknown) => {
      forwarded = err;
    });

    assert(forwarded instanceof Error);
    assert.equal(updatePlanCalled, false);
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
    assert.deepEqual(capturedOptions?.actions, ['admin.workspace.member.add', 'admin.workspace.member.delete', 'admin.workspace.member.role.update', 'admin.member.role.update']);
    assert.equal(capturedOptions?.actionGroup, 'workspace_access_modified');
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
