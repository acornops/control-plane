import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { config } from '../../src/config.js';
import {
  configureWorkflowBuiltInMcpCatalogForTests,
  loadWorkflowBuiltInMcpCatalog
} from '../../src/services/workflow-built-in-mcp-catalog.js';
import type { TargetSummary } from '../../src/types/domain.js';

afterEach(() => {
  mock.restoreAll();
  configureWorkflowBuiltInMcpCatalogForTests();
});

const target: TargetSummary = {
  id: 'cluster-1',
  workspaceId: 'workspace-1',
  targetType: 'kubernetes',
  name: 'Production',
  status: 'online',
  metadata: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

describe('workflow built-in MCP catalog', () => {
  it('excludes remote MCP servers and non-built-in tools', async () => {
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/internal/mcp/servers?')) {
        return new Response(JSON.stringify([
          {
            id: 'builtin-server', workspace_id: 'workspace-1', target_id: 'cluster-1', target_type: 'kubernetes',
            server_name: config.BUILTIN_TARGET_MCP_SERVER_NAME, server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
            enabled: true, auth_type: 'none', tools: []
          },
          {
            id: 'remote-server', workspace_id: 'workspace-1', target_id: 'cluster-1', target_type: 'kubernetes',
            server_name: 'remote-mcp-server', server_url: 'https://mock.example.test/mcp',
            enabled: true, auth_type: 'none', tools: []
          }
        ]), { status: 200 });
      }
      return new Response(JSON.stringify([
        {
          name: 'list_resources', mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL, timeout_ms: 10000,
          description: 'List Kubernetes resources', capability: 'read', source: 'builtin', enabled: true
        },
        {
          name: 'get_weather', mcp_server_url: 'https://mock.example.test/mcp', timeout_ms: 10000,
          description: 'Mock weather tool', capability: 'read', source: 'mcp', enabled: true
        }
      ]), { status: 200 });
    });

    const catalog = await loadWorkflowBuiltInMcpCatalog('workspace-1', [target]);

    assert.equal(catalog.server.id, 'acornops-target-agent');
    assert.equal(catalog.server.enabled, true);
    assert.deepEqual(catalog.tools.map((tool) => tool.name), ['list_resources']);
  });
});
