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
  it('preserves AgentV-advertised tool capabilities during built-in sync', async () => {
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
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/api/v1/internal/mcp/servers') && init?.method === 'POST') {
        createdBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          id: 'server-1',
          workspace_id: 'ws-1',
          target_id: 'vm-1',
          target_type: 'virtual_machine',
          server_name: config.BUILTIN_TARGET_MCP_SERVER_NAME,
          server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
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
    const tools = createdBody?.tools as Array<Record<string, unknown>>;
    assert.equal(tools.some((tool) => tool.name === '_acornops_load_skill'), false);
    assert.equal(tools.find((tool) => tool.name === 'restart_service')?.capability, 'write');
    assert.deepEqual(tools.find((tool) => tool.name === 'restart_service')?.output_schema, { type: 'object' });
    assert.equal(tools.find((tool) => tool.name === 'restart_service')?.artifact_policy, 'always');
    assert.equal(tools.find((tool) => tool.name === 'query_logs')?.capability, 'read');
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

  it('adds patch_resource and removes stale mutation tools when AgentK discovery changes', async () => {
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
          server_name: config.BUILTIN_TARGET_MCP_SERVER_NAME, server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
          enabled: true, auth_type: 'none', tools: []
        }]), { status: 200 });
      }
      if (url.includes('/api/v1/internal/mcp/tools?')) {
        return new Response(JSON.stringify([
          { name: 'list_resources', mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL, timeout_ms: 10000, source: 'builtin', enabled: true },
          { name: 'apply_remediation', mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL, timeout_ms: 10000, source: 'builtin', enabled: true },
          { name: 'simulate_patch', mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL, timeout_ms: 10000, source: 'builtin', enabled: true }
        ]), { status: 200 });
      }
      if (url.includes('/api/v1/internal/mcp/servers/builtin-1?') && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          id: 'builtin-1', workspace_id: 'ws-1', target_id: 'cluster-1', target_type: 'kubernetes',
          server_name: config.BUILTIN_TARGET_MCP_SERVER_NAME, server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
          enabled: true, auth_type: 'none', tools: patchBody?.tools
        }), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const result = await syncTargetBuiltInTools('ws-1', 'cluster-1', 'kubernetes');

    assert.equal(result.ok, true);
    assert.deepEqual(result.addedTools, ['patch_resource']);
    assert.deepEqual(result.removedTools, ['apply_remediation', 'simulate_patch']);
    assert.deepEqual(patchBody?.remove_tools, ['apply_remediation', 'simulate_patch']);
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
