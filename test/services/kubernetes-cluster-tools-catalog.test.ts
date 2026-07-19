import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../../src/config.js';
import {
  composeKubernetesClusterToolsCatalog,
  composeTargetToolsCatalog
} from '../../src/services/kubernetes-cluster-tools-catalog.js';
import type { McpServerConfig, McpToolConfig } from '../../src/services/mcp-registry-client.js';

function builtInServer(targetId: string, targetType: 'kubernetes' | 'virtual_machine' = 'kubernetes'): McpServerConfig {
  return {
    id: `server-${targetId}`,
    workspace_id: 'ws-1',
    target_id: targetId,
    target_type: targetType,
    server_name: targetId,
    server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
    provenance_type: 'builtin',
    enabled: true,
    auth_type: 'none',
    tools: []
  };
}

describe('composeKubernetesClusterToolsCatalog', () => {
  it('does not synthesize a server for tools whose live server is missing', () => {
    const tools: McpToolConfig[] = [
      {
        name: 'describe_pod',
        mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
        timeout_ms: 5000,
        description: 'Describe a pod',
        capability: 'write',
        version: '2026.05',
        source: 'builtin',
        enabled: true
      }
    ];

    const catalog = composeKubernetesClusterToolsCatalog({
      workspaceId: 'ws-1',
      clusterId: 'cluster-1',
      canEdit: true,
      tools,
      servers: [],
      overrides: {},
      targetSupportsWrite: true,
      targetAgentConnected: true
    });

    assert.equal(catalog.permissions.canEdit, true);
    assert.deepEqual(catalog.permissions.editableRoles, ['owner', 'admin']);
    assert.deepEqual(catalog.servers, []);
  });

  it('hides stale gateway discovery failures for the builtin managed server', () => {
    const catalog = composeKubernetesClusterToolsCatalog({
      workspaceId: 'ws-1',
      clusterId: 'cluster-1',
      canEdit: true,
      tools: [
        {
          name: 'list_pods',
          mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
          timeout_ms: 5000,
          description: 'List pods',
          capability: 'read',
          version: 'v1',
          source: 'builtin',
          enabled: true
        }
      ],
      servers: [
        {
          id: 'builtin-server',
          workspace_id: 'ws-1',
          target_id: 'cluster-1',
          target_type: 'kubernetes',
          server_name: 'cluster-1',
          server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
          provenance_type: 'builtin',
          enabled: true,
          auth_type: 'none',
          connection_status: 'error',
          last_discovery_at: '2026-06-27T00:00:00.000Z',
          last_discovery_error: 'Failed to connect to MCP server',
          tools: []
        }
      ],
      overrides: {},
      targetSupportsWrite: true,
      targetAgentConnected: true
    });

    assert.equal(catalog.servers[0]?.type, 'builtin');
    assert.equal(catalog.servers[0]?.connectionStatus, 'ok');
    assert.equal(catalog.servers[0]?.lastDiscoveryAt, null);
    assert.equal(catalog.servers[0]?.lastDiscoveryError, null);
  });

  it('normalizes tool metadata, ignores name-only overrides for remote tools, and preserves legacy enablement', () => {
    const servers: McpServerConfig[] = [
      {
        id: 'server-b',
        workspace_id: 'ws-1',
        target_id: 'cluster-1',
        target_type: 'kubernetes',
        server_name: 'Zeta Server',
        server_url: 'https://zeta.example.com/mcp',
        enabled: false,
        auth_type: 'custom_header',
        connection_status: 'error',
        last_discovery_at: '2026-05-25T00:00:00.000Z',
        last_discovery_error: 'boom',
        tools: []
      },
      {
        id: 'server-a',
        workspace_id: 'ws-1',
        target_id: 'cluster-1',
        target_type: 'kubernetes',
        server_name: 'Alpha Server',
        server_url: 'https://alpha.example.com/mcp',
        enabled: true,
        auth_type: 'bearer_token',
        connection_status: 'ok',
        last_discovery_at: null,
        last_discovery_error: null,
        tools: []
      }
    ];
    const tools: McpToolConfig[] = [
      {
        name: 'z-read',
        mcp_server_url: 'https://zeta.example.com/mcp',
        timeout_ms: 1000,
        source: 'mcp'
      },
      {
        name: 'a-write',
        mcp_server_url: 'https://alpha.example.com/mcp',
        timeout_ms: 1000,
        description: 'Alpha write tool',
        capability: 'write',
        version: 'v2',
        source: 'mcp',
        enabled: false
      }
    ];

    const catalog = composeKubernetesClusterToolsCatalog({
      workspaceId: 'ws-1',
      clusterId: 'cluster-1',
      canEdit: false,
      tools,
      servers,
      overrides: { 'a-write': true },
      targetSupportsWrite: true,
      targetAgentConnected: true
    });

    assert.deepEqual(
      catalog.servers.map((server) => ({ name: server.name, type: server.type })),
      [
        { name: 'Alpha Server', type: 'mcp' },
        { name: 'Zeta Server', type: 'mcp' }
      ]
    );
    assert.deepEqual(catalog.servers[0]?.tools, [
      {
        name: 'a-write',
        description: 'Alpha write tool',
        capability: 'write',
        version: 'v2',
        source: 'mcp',
        enabledConfigured: false,
        enabledEffective: false,
        effectiveDisabledReason: null
      }
    ]);
    assert.deepEqual(catalog.servers[1]?.tools, [
      {
        name: 'z-read',
        description: 'Execute tool "z-read"',
        capability: 'write',
        version: 'v1',
        source: 'mcp',
        enabledConfigured: true,
        enabledEffective: false,
        effectiveDisabledReason: 'server_disabled'
      }
    ]);
    assert.deepEqual(catalog.servers[1]?.toolCounts, {
      total: 1,
      enabledConfigured: 1,
      enabledEffective: 0,
      writeConfigured: 1,
      writeEffective: 0
    });
  });

  it('does not synthesize a remote server for unbound tools', () => {
    const catalog = composeKubernetesClusterToolsCatalog({
      workspaceId: 'ws-2',
      clusterId: 'cluster-2',
      canEdit: false,
      tools: [
        {
          name: 'orphan-tool',
          mcp_server_url: 'tool://orphan-tool',
          timeout_ms: 1000,
          source: 'mcp',
          enabled: true
        }
      ],
      servers: [],
      overrides: {},
      targetSupportsWrite: true,
      targetAgentConnected: true
    });

    assert.deepEqual(catalog.servers, []);
  });

  it('uses the same target catalog shape and capability counts for VM targets', () => {
    const catalog = composeTargetToolsCatalog({
      workspaceId: 'ws-3',
      targetId: 'vm-1',
      targetType: 'virtual_machine',
      canEdit: true,
      servers: [builtInServer('vm-1', 'virtual_machine')],
      overrides: {},
      targetSupportsWrite: true,
      targetAgentConnected: true,
      tools: [
        {
          name: 'restart_service',
          mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
          timeout_ms: 10000,
          description: 'Restart a service',
          capability: 'write',
          version: 'v2',
          source: 'builtin',
          enabled: true
        }
      ]
    });

    assert.equal(catalog.targetId, 'vm-1');
    assert.equal(catalog.targetType, 'virtual_machine');
    assert.equal(catalog.clusterId, undefined);
    assert.equal(catalog.servers[0]?.type, 'builtin');
    assert.deepEqual(catalog.servers[0]?.toolCounts, {
      total: 1,
      enabledConfigured: 1,
      enabledEffective: 1,
      writeConfigured: 1,
      writeEffective: 1
    });
    assert.equal(catalog.servers[0]?.tools[0]?.capability, 'write');
  });

  it('marks configured write tools ineffective when the agent is read-only', () => {
    const catalog = composeKubernetesClusterToolsCatalog({
      workspaceId: 'ws-4',
      clusterId: 'cluster-4',
      canEdit: true,
      servers: [builtInServer('cluster-4')],
      overrides: {},
      targetSupportsWrite: false,
      targetAgentConnected: true,
      tools: [
        {
          name: 'restart_workload',
          mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
          timeout_ms: 10000,
          description: 'Restart a workload',
          capability: 'write',
          version: 'v1',
          source: 'builtin',
          enabled: true
        },
        {
          name: 'list_resources',
          mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
          timeout_ms: 10000,
          description: 'List resources',
          capability: 'read',
          version: 'v1',
          source: 'builtin',
          enabled: true
        }
      ]
    });

    assert.deepEqual(catalog.servers[0]?.toolCounts, {
      total: 2,
      enabledConfigured: 2,
      enabledEffective: 1,
      writeConfigured: 1,
      writeEffective: 0
    });
    assert.deepEqual(catalog.servers[0]?.tools, [
      {
        name: 'list_resources',
        description: 'List resources',
        capability: 'read',
        version: 'v1',
        source: 'builtin',
        enabledConfigured: true,
        enabledEffective: true,
        effectiveDisabledReason: null
      },
      {
        name: 'restart_workload',
        description: 'Restart a workload',
        capability: 'write',
        version: 'v1',
        source: 'builtin',
        enabledConfigured: true,
        enabledEffective: false,
        effectiveDisabledReason: 'agent_write_disabled'
      }
    ]);
  });

  it('marks built-in tools unavailable while the target agent is disconnected', () => {
    const catalog = composeKubernetesClusterToolsCatalog({
      workspaceId: 'ws-5',
      clusterId: 'cluster-5',
      canEdit: true,
      servers: [builtInServer('cluster-5')],
      overrides: {},
      targetSupportsWrite: true,
      targetAgentConnected: false,
      tools: [{
        name: 'get_resource',
        mcp_server_url: config.BUILTIN_TARGET_MCP_SERVER_URL,
        timeout_ms: 12000,
        description: 'Get a resource',
        capability: 'read',
        version: 'v1',
        source: 'builtin',
        enabled: true
      }]
    });

    assert.equal(catalog.servers[0]?.connectionStatus, 'error');
    assert.equal(catalog.servers[0]?.tools[0]?.enabledEffective, false);
    assert.equal(catalog.servers[0]?.tools[0]?.effectiveDisabledReason, 'agent_disconnected');
  });
});
