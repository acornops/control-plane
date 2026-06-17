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
  it('preserves VM agent-advertised tool capabilities during built-in sync', async () => {
    mock.method(agentGateway, 'listAgentTools', async () => [
      {
        name: 'restart_service',
        description: 'Restart a systemd service',
        capability: 'write' as const,
        timeout_ms: 12000,
        version: 'v2',
        input_schema: { type: 'object' }
      },
      {
        name: 'get_logs',
        description: 'Read logs',
        capability: 'read' as const,
        timeout_ms: 10000,
        version: 'v1'
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
          server_name: config.BUILTIN_MCP_SERVER_NAME,
          server_url: config.BUILTIN_MCP_SERVER_URL,
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
    assert.equal(tools.find((tool) => tool.name === 'restart_service')?.capability, 'write');
    assert.equal(tools.find((tool) => tool.name === 'get_logs')?.capability, 'read');
  });

  it('reports failure when built-in tools cannot be registered in llm-gateway', async () => {
    mock.method(agentGateway, 'listAgentTools', async () => [
      {
        name: 'get_logs',
        description: 'Read logs',
        capability: 'read' as const
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
});
