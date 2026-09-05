import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { agentGateway } from '../../src/agent/ws-server.js';
import { config } from '../../src/config.js';
import { syncTargetBuiltInTools } from '../../src/services/target-built-in-tool-sync.js';
import { webhooks } from '../../src/services/webhooks.js';

afterEach(() => {
  mock.restoreAll();
});

describe('syncTargetBuiltInTools', () => {
  it('preserves AgentV-advertised tool capabilities and ignores workspace-owned MCP servers during built-in sync', async () => {
    mock.method(agentGateway, 'listAgentTools', async () => [
      {
        name: 'restart_service',
        description: 'Restart a systemd service',
        capability: 'write' as const,
        timeout_ms: 12000,
        version: 'v2',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        artifactPolicy: 'always' as const
      },
      {
        name: '_acornops_load_skill',
        description: 'Reserved internal loader collision',
        capability: 'read' as const,
        timeout_ms: 10000,
        version: 'v1'
      },
      {
        name: 'query_logs',
        description: 'Read logs',
        capability: 'read' as const,
        timeout_ms: 10000,
        version: 'v2',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        artifactPolicy: 'if_detailed' as const
      }
    ]);
    mock.method(webhooks, 'emit', () => undefined);

    let createdBody: Record<string, unknown> | undefined;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/servers?')) {
        return new Response(JSON.stringify([{
          id: 'workspace-server-1',
          workspace_id: 'ws-1',
          target_id: 'vm-1',
          target_type: 'virtual_machine',
          server_name: 'Workspace MCP',
          server_url: 'https://mcp.example.test',
          provenance_type: 'manual',
          enabled: true,
          auth_type: 'none',
          tools: []
        }]), { status: 200 });
      }
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/api/v1/internal/mcp/servers/builtin') && init?.method === 'PUT') {
        createdBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          id: 'server-1',
          workspace_id: 'ws-1',
          target_id: 'vm-1',
          target_type: 'virtual_machine',
          server_name: 'vm-1',
          server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
          provenance_type: 'builtin',
          enabled: true,
          auth_type: 'none',
          tools: createdBody?.tools
        }), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const result = await syncTargetBuiltInTools('ws-1', 'vm-1', 'virtual_machine');

    assert.equal(result.ok, true);
    assert.equal(result.discoveredToolCount, 2);
    assert.equal(result.registeredToolCount, 2);
    assert.equal(createdBody?.target_type, 'virtual_machine');
    assert.equal(createdBody?.server_name, config.BUILTIN_TARGET_MCP_SERVER_NAME);
    assert.equal(createdBody?.server_id, undefined);
    const tools = createdBody?.tools as Array<Record<string, unknown>>;
    assert.equal(tools.some((tool) => tool.name === '_acornops_load_skill'), false);
    assert.equal(tools.find((tool) => tool.name === 'restart_service')?.capability, 'write');
    assert.equal(tools.find((tool) => tool.name === 'restart_service')?.review_state, 'approved');
    assert.equal(tools.find((tool) => tool.name === 'restart_service')?.risk_level, 'non_destructive_write');
    assert.equal(tools.find((tool) => tool.name === 'restart_service')?.auto_allowed, true);
    assert.deepEqual(tools.find((tool) => tool.name === 'restart_service')?.output_schema, { type: 'object' });
    assert.equal(tools.find((tool) => tool.name === 'restart_service')?.artifact_policy, 'always');
    assert.equal(tools.find((tool) => tool.name === 'query_logs')?.capability, 'read');
    assert.equal(tools.find((tool) => tool.name === 'query_logs')?.review_state, 'approved');
    assert.equal(tools.find((tool) => tool.name === 'query_logs')?.risk_level, 'read_only');
    assert.equal(tools.find((tool) => tool.name === 'query_logs')?.auto_allowed, false);
  });

  it('reports failure when built-in tools cannot be registered in llm-gateway', async () => {
    mock.method(agentGateway, 'listAgentTools', async () => [
      {
        name: 'query_logs',
        description: 'Read logs',
        capability: 'read' as const,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        artifactPolicy: 'if_detailed' as const
      }
    ]);
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/servers?')) {
        return new Response('gateway down', { status: 503 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const result = await syncTargetBuiltInTools('ws-1', 'vm-1', 'virtual_machine');

    assert.equal(result.ok, false);
    assert.equal(result.registeredToolCount, 0);
    assert.match(result.error || '', /gateway down|llm-gateway request failed/);
  });

  it('treats a lifecycle fence as terminal and does not attempt built-in mutation', async () => {
    mock.method(agentGateway, 'listAgentTools', async () => [{
      name: 'query_logs', description: 'Read logs', capability: 'read' as const,
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, artifactPolicy: 'never' as const
    }]);
    const gateway = mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/servers?') && init?.method === 'GET') {
        return Response.json({ detail: {
          code: 'MCP_LIFECYCLE_FENCED',
          message: 'MCP lifecycle teardown is in progress for this destination.',
          retryable: false
        } }, { status: 409 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const result = await syncTargetBuiltInTools('ws-1', 'vm-1', 'virtual_machine');

    assert.equal(result.ok, false);
    assert.equal(result.terminal, true);
    assert.equal(result.error, 'MCP_LIFECYCLE_FENCED');
    assert.ok(gateway.mock.calls.every((call) => call.arguments[1]?.method === 'GET'));
  });

  it('rotates built-in URL and name on the same server while reconciling AgentK tools', async () => {
    mock.method(agentGateway, 'listAgentTools', async () => [
      {
        name: 'list_resources', description: 'List resources', capability: 'read' as const, inputSchema: { type: 'object' },
        outputSchema: { type: 'object' }, artifactPolicy: 'always' as const,
      },
      {
        name: 'patch_resource', description: 'Patch one resource', capability: 'write' as const, inputSchema: { type: 'object' },
        outputSchema: { type: 'object' }, artifactPolicy: 'never' as const,
      },
    ]);
    mock.method(webhooks, 'emit', () => undefined);
    let patchBody: Record<string, unknown> | undefined;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/servers?')) {
        return new Response(JSON.stringify([{
          id: 'builtin-1', workspace_id: 'ws-1', target_id: 'cluster-1', target_type: 'kubernetes',
          server_name: 'outdated-built-in', server_url: 'http://old-control-plane:8081/internal/v1/mcp',
          provenance_type: 'builtin', enabled: true, auth_type: 'none', tools: []
        }]), { status: 200 });
      }
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([
          { name: 'list_resources', server_id: 'builtin-1', mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL, timeout_ms: 10000, source: 'builtin', enabled: false },
          { name: 'apply_remediation', server_id: 'builtin-1', mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL, timeout_ms: 10000, source: 'builtin', enabled: true },
          { name: 'simulate_patch', server_id: 'builtin-1', mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL, timeout_ms: 10000, source: 'builtin', enabled: true }
        ]), { status: 200 });
      }
      if (url.endsWith('/api/v1/internal/mcp/servers/builtin') && init?.method === 'PUT') {
        patchBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          id: 'builtin-1', workspace_id: 'ws-1', target_id: 'cluster-1', target_type: 'kubernetes',
          server_name: 'cluster-1', server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
          provenance_type: 'builtin', enabled: true, auth_type: 'none', tools: patchBody?.tools
        }), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const result = await syncTargetBuiltInTools('ws-1', 'cluster-1', 'kubernetes');

    assert.equal(result.ok, true);
    assert.deepEqual(result.addedTools, ['patch_resource']);
    assert.deepEqual(result.removedTools, ['apply_remediation', 'simulate_patch']);
    assert.equal(patchBody?.server_name, config.BUILTIN_TARGET_MCP_SERVER_NAME);
    assert.equal(patchBody?.server_id, 'builtin-1');
    assert.equal(patchBody?.server_url, undefined);
    assert.equal(patchBody?.remove_tools, undefined);
    const tools = patchBody?.tools as Array<Record<string, unknown>>;
    assert.equal(tools.find((tool) => tool.name === 'list_resources')?.enabled, false);
    assert.equal(tools.find((tool) => tool.name === 'patch_resource')?.review_state, 'approved');
    assert.equal(tools.find((tool) => tool.name === 'patch_resource')?.risk_level, 'non_destructive_write');
    assert.equal(tools.find((tool) => tool.name === 'patch_resource')?.auto_allowed, true);
  });

  it('fails AgentK synchronization when the result contract is incomplete', async () => {
    mock.method(agentGateway, 'listAgentTools', async () => [{
      name: 'get_resource', description: 'Get a resource', capability: 'read' as const,
      inputSchema: { type: 'object' },
    }]);
    const result = await syncTargetBuiltInTools('ws-1', 'cluster-1', 'kubernetes');

    assert.equal(result.ok, false);
    assert.match(result.error || '', /missing a valid output schema/);
  });
});
