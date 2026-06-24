import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getWorkspace, listWorkspaces } from '../src/controllers/workspaces-controller.js';
import { repo } from '../src/store/repository.js';
import type { WorkspaceSummary } from '../src/types/domain.js';

const originalListWorkspacesForUser = repo.listWorkspacesForUser;
const originalGetWorkspaceSummaryForUser = repo.getWorkspaceSummaryForUser;

afterEach(() => {
  repo.listWorkspacesForUser = originalListWorkspacesForUser;
  repo.getWorkspaceSummaryForUser = originalGetWorkspaceSummaryForUser;
});

function createWorkspaceSummary(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    plan: { key: 'default', name: 'Default' },
    createdBy: 'owner-1',
    createdAt: '2026-05-30T00:00:00.000Z',
    currentUserRole: 'viewer',
    permissions: {
      read_workspace_data: true,
      read_members: true,
      read_audit_log: false,
      delete_workspace: false,
      manage_members: false,
      manage_targets: false,
      manage_mcp: false,
      manage_tools: false,
      manage_agent_keys: false,
      manage_webhooks: false,
      create_sessions: false,
      create_read_only_runs: false,
      create_read_write_runs: false,
      read_target_logs: false,
      cancel_runs: false,
      delete_sessions: false
    },
    clusterCount: 0,
    memberCount: 1,
    quota: {
      members: { used: 1, limit: 100 },
      kubernetesClusters: { used: 0, limit: 10 },
      virtualMachines: { used: 0, limit: 10 }
    },
    ...overrides
  };
}

function createRequest(params: Record<string, string> = {}) {
  return {
    params,
    query: {},
    auth: {
      userId: 'user-1',
      credential: { type: 'session' as const, sessionId: 'session-1' }
    }
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
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

describe('workspace summary authorization', () => {
  it('filters unsupported role memberships from workspace lists', async () => {
    repo.listWorkspacesForUser = async () => ({
      items: [
        createWorkspaceSummary({ id: 'workspace-supported', currentUserRole: 'viewer' }),
        createWorkspaceSummary({ id: 'workspace-unsupported', currentUserRole: 'retired_role' })
      ],
      nextCursor: undefined
    });
    const res = createResponse();

    await listWorkspaces(createRequest() as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as { items: WorkspaceSummary[] }).items.map((workspace) => workspace.id), ['workspace-supported']);
  });

  it('fails closed for direct workspace summary reads with unsupported roles', async () => {
    repo.getWorkspaceSummaryForUser = async () => createWorkspaceSummary({ currentUserRole: 'retired_role' });
    const res = createResponse();

    await getWorkspace(createRequest({ workspaceId: 'workspace-1' }) as never, res as never, (err?: unknown) => {
      if (err) throw err;
    });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, {
      error: { code: 'NOT_FOUND', message: 'Workspace not found', retryable: false }
    });
  });

});
