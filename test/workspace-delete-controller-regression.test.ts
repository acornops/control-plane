import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
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
  it('cleans up target-scoped MCP servers for every target type before deleting a workspace', async () => {
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

    const listedTargetTypes: string[] = [];
    const deletedTargets: Array<{ targetId: string | null; targetType: string | null; serverId: string }> = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/connections' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith('/api/v1/internal/llm/provider-credentials/') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ provider: url.pathname.split('/').at(-1), configured: false, enabled: true }), {
          status: 200
        });
      }
      if (url.pathname === '/api/v1/internal/mcp/servers' && init?.method === 'GET') {
        const targetId = url.searchParams.get('target_id');
        listedTargetTypes.push(url.searchParams.get('target_type') || '');
        return new Response(JSON.stringify([
          {
            id: `${targetId}-server`,
            workspace_id: 'workspace-1',
            target_id: targetId,
            target_type: url.searchParams.get('target_type'),
            server_name: 'ops-mcp',
            server_url: 'https://mcp.example.test',
            enabled: true,
            auth_type: 'none',
            tools: []
          }
        ]), { status: 200 });
      }
      if (url.pathname.startsWith('/api/v1/internal/mcp/servers/') && init?.method === 'DELETE') {
        deletedTargets.push({
          targetId: url.searchParams.get('target_id'),
          targetType: url.searchParams.get('target_type'),
          serverId: decodeURIComponent(url.pathname.split('/').at(-1) || '')
        });
        return new Response(null, { status: 204 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const deleted = await callController(deleteWorkspace, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(listedTargetTypes, ['kubernetes', 'virtual_machine']);
    assert.deepEqual(deletedTargets, [
      { targetId: 'cluster-1', targetType: 'kubernetes', serverId: 'cluster-1-server' },
      { targetId: 'target-1', targetType: 'virtual_machine', serverId: 'target-1-server' }
    ]);
  });

  it('maps AI credential cleanup gateway failures with workspace AI error copy', async () => {
    installWorkspace('owner');
    repo.getWorkspaceSummaryForUser = async () => createWorkspaceSummary();
    repo.listTargets = async () => ({ items: [], nextCursor: undefined });
    repo.deleteWorkspace = async () => true;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/connections' && init?.method === 'DELETE') {
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

  it('aborts workspace deletion when personal MCP credential cleanup cannot complete', async () => {
    installWorkspace('owner');
    repo.getWorkspaceSummaryForUser = async () => createWorkspaceSummary();
    repo.listTargets = async () => ({ items: [], nextCursor: undefined });
    let workspaceDeleted = false;
    repo.deleteWorkspace = async () => {
      workspaceDeleted = true;
      return true;
    };
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/internal/mcp/connections' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ detail: 'secret backend unavailable' }), { status: 503 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(deleteWorkspace, createRequest({ workspaceId: 'workspace-1' }));

    assert.equal(response.statusCode, 503);
    assert.equal((response.body as { error: { code: string } }).error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(
      (response.body as { error: { message: string } }).error.message,
      'Failed to clean up personal MCP credentials with llm-gateway'
    );
    assert.equal(workspaceDeleted, false);
  });
});
