import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { deleteWorkspace } from '../src/controllers/workspaces-controller.js';
import { repo } from '../src/store/repository.js';
import type { WorkspaceSummary } from '../src/types/domain.js';
import {
  callController,
  createRequest,
  createTarget,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);
beforeEach(() => {
  mock.method(repo, 'enqueueWebhookOutboxEvent', async () => null);
});

function createWorkspaceSummary(): WorkspaceSummary {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    plan: { key: 'default', name: 'Default' },
    createdBy: 'user-1',
    createdAt: '2026-05-24T00:00:00.000Z',
    currentUserRole: 'owner',
    permissions: {
      read_workspace_data: true,
      read_members: true,
      read_audit_log: true,
      delete_workspace: true,
      manage_members: true,
      manage_targets: true,
      manage_mcp: true,
      manage_tools: true,
      manage_skills: true,
      manage_ai_settings: true,
      manage_agent_keys: true,
      manage_webhooks: true,
      create_sessions: true,
      create_read_only_runs: true,
      create_read_write_runs: true,
      read_target_logs: true,
      cancel_runs: true,
      delete_sessions: true
    },
    clusterCount: 1,
    memberCount: 1,
    quota: {
      members: { used: 1, limit: 100 },
      kubernetesClusters: { used: 1, limit: 10 },
      virtualMachines: { used: 1, limit: 10 }
    }
  };
}

describe('workspace deletion controller regressions', () => {
  it('tears down all MCP state once for a mixed-target workspace before local deletion', async () => {
    installWorkspace('owner');
    repo.getWorkspaceSummaryForUser = async () => createWorkspaceSummary();
    repo.listTargets = async () => ({
      items: [
        createTarget({ id: 'cluster-1', targetType: 'kubernetes', name: 'cluster' }),
        createTarget({ id: 'target-1', targetType: 'virtual_machine', name: 'vm' })
      ],
      nextCursor: undefined
    });
    repo.deleteWorkspace = async () => true;

    const operations: string[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/workspaces/workspace-1' && init?.method === 'DELETE') {
        operations.push('mcp-workspace-teardown');
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith('/api/v1/internal/llm/provider-credentials/') && init?.method === 'DELETE') {
        operations.push('ai-credential-cleanup');
        return new Response(JSON.stringify({ provider: url.pathname.split('/').at(-1), configured: false, enabled: true }), {
          status: 200
        });
      }
      return new Response('unexpected request', { status: 500 });
    });
    repo.deleteWorkspace = async () => {
      operations.push('local-workspace-delete');
      return true;
    };

    const deleted = await callController(deleteWorkspace, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(deleted.statusCode, 204);
    assert.equal(operations.filter((operation) => operation === 'mcp-workspace-teardown').length, 1);
    assert(operations.indexOf('mcp-workspace-teardown') < operations.indexOf('local-workspace-delete'));
    assert(operations.indexOf('ai-credential-cleanup') < operations.indexOf('local-workspace-delete'));
  });

  it('tears down Agent-only workspace MCP state even when no targets exist', async () => {
    installWorkspace('owner');
    repo.getWorkspaceSummaryForUser = async () => createWorkspaceSummary();
    repo.listTargets = async () => ({ items: [], nextCursor: undefined });
    repo.deleteWorkspace = async () => true;
    const lifecyclePaths: string[] = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/workspaces/workspace-1' && init?.method === 'DELETE') {
        lifecyclePaths.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith('/api/v1/internal/llm/provider-credentials/') && init?.method === 'DELETE') {
        return Response.json({ configured: false, enabled: true });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const deleted = await callController(deleteWorkspace, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(lifecyclePaths, ['/api/v1/internal/mcp/workspaces/workspace-1']);
  });

  it('maps AI credential cleanup gateway failures with workspace AI error copy', async () => {
    installWorkspace('owner');
    repo.getWorkspaceSummaryForUser = async () => createWorkspaceSummary();
    repo.listTargets = async () => ({ items: [], nextCursor: undefined });
    repo.deleteWorkspace = async () => true;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/workspaces/workspace-1' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith('/api/v1/internal/llm/provider-credentials/') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ detail: 'llm-gateway unavailable' }), { status: 503 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(deleteWorkspace, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Failed to synchronize AI provider settings with llm-gateway',
        retryable: true
      }
    });
  });

  it('keeps the workspace locally present when lifecycle teardown fails so deletion can retry', async () => {
    installWorkspace('owner');
    repo.getWorkspaceSummaryForUser = async () => createWorkspaceSummary();
    repo.listTargets = async () => ({ items: [], nextCursor: undefined });
    let workspaceDeleted = false;
    repo.deleteWorkspace = async () => {
      workspaceDeleted = true;
      return true;
    };
    let teardownAttempts = 0;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/workspaces/workspace-1' && init?.method === 'DELETE') {
        teardownAttempts += 1;
        return teardownAttempts === 1
          ? Response.json({ detail: {
              code: 'MCP_LIFECYCLE_TEARDOWN_FAILED',
              message: 'MCP lifecycle teardown did not complete; retry the request.',
              retryable: true
            } }, { status: 503 })
          : new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith('/api/v1/internal/llm/provider-credentials/') && init?.method === 'DELETE') {
        return Response.json({ configured: false, enabled: true });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(deleteWorkspace, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 503);
    assert.equal((response.body as { error: { code: string } }).error.code, 'MCP_LIFECYCLE_TEARDOWN_FAILED');
    assert.equal(
      (response.body as { error: { message: string } }).error.message,
      'Failed to clean up workspace MCP state with llm-gateway'
    );
    assert.equal(workspaceDeleted, false);

    const retried = await callController(deleteWorkspace, createRequest({ workspaceId: 'workspace-1' }));
    assert.equal(retried.statusCode, 204);
    assert.equal(workspaceDeleted, true);
    assert.equal(teardownAttempts, 2);
  });
});
