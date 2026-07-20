import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import {
  importCatalogMcpServer,
  listCatalogSources,
  updateCatalogSource
} from '../../src/services/mcp-catalog-client.js';

afterEach(() => mock.restoreAll());

function gatewayServer() {
  return {
    id: 'server-1',
    server_name: 'Operations',
    server_url: 'https://mcp.example/mcp',
    enabled: true,
    auth_type: 'none',
    credential_mode: 'none',
    credential_configured: false,
    public_headers: {},
    connection_status: 'ok',
    last_discovery_at: null,
    last_discovery_error: null,
    revision: 1,
    provenance_type: 'catalog',
    target_constraints: {},
    tools: []
  };
}

describe('MCP catalog import gateway contract', () => {
  it('sends a target discriminator without Agent constraints or credentials', async () => {
    let body: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(gatewayServer()), { status: 201 });
    });

    await importCatalogMcpServer({
      workspaceId: 'workspace-1',
      scopeType: 'target',
      targetId: 'target-1',
      targetType: 'kubernetes',
      artifact: { artifactId: 'artifact-1' },
      version: '1.2.3',
      remoteEndpoint: 'https://mcp.example/mcp'
    });

    assert.equal(body.scope_type, 'target');
    assert.equal(body.target_id, 'target-1');
    assert.equal(body.target_type, 'kubernetes');
    assert.equal('agent_id' in body, false);
    assert.equal('target_constraints' in body, false);
    assert.equal('credential' in body, false);
  });

  it('keeps Agent scope and constraints isolated from target fields', async () => {
    let body: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(gatewayServer()), { status: 201 });
    });

    await importCatalogMcpServer({
      workspaceId: 'workspace-1',
      scopeType: 'agent',
      agentId: 'agent-1',
      targetConstraints: { targetTypes: ['virtual_machine'], targetIds: ['vm-1'] },
      artifact: { sourceId: 'source-1', artifactName: 'operations' },
      version: '2.0.0',
      remoteEndpoint: 'https://mcp.example/mcp',
      reimportServerId: 'server-1',
      expectedRevision: 3
    });

    assert.equal(body.scope_type, 'agent');
    assert.equal(body.agent_id, 'agent-1');
    assert.deepEqual(body.target_constraints, { target_types: ['virtual_machine'], target_ids: ['vm-1'] });
    assert.equal('target_id' in body, false);
    assert.equal('target_type' in body, false);
    assert.equal(body.expected_revision, 3);
  });
});

describe('MCP registry lifecycle gateway contract', () => {
  it('maps source-management capabilities from the gateway list response', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      items: [],
      capabilities: {
        workspace_managed_sources_enabled: false,
        supported_network_routes: ['direct']
      }
    }), { status: 200 }));

    const response = await listCatalogSources('workspace-1');

    assert.equal(response.capabilities.workspace_managed_sources_enabled, false);
    assert.deepEqual(response.capabilities.supported_network_routes, ['direct']);
  });

  it('omits authentication when a patch must preserve the stored credential', async () => {
    let body: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'source-1', workspace_id: 'workspace-1', display_name: 'Internal',
        base_url: 'https://registry.example', auth_type: 'bearer_token',
        credential_configured: true, network_route: 'direct', enabled: false,
        management_mode: 'workspace', bindings: []
      }), { status: 200 });
    });

    await updateCatalogSource({
      workspaceId: 'workspace-1', sourceId: 'source-1', enabled: false
    });

    assert.equal('auth' in body, false);
    assert.equal(body.enabled, false);
  });

  it('sends a new write-only credential when replacing authentication', async () => {
    let body: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'source-1', workspace_id: 'workspace-1', display_name: 'Internal',
        base_url: 'https://registry.example', auth_type: 'custom_header',
        credential_configured: true, auth_header_name: 'X-Registry-Key',
        network_route: 'direct', enabled: true, management_mode: 'workspace',
        bindings: []
      }), { status: 200 });
    });

    await updateCatalogSource({
      workspaceId: 'workspace-1',
      sourceId: 'source-1',
      auth: {
        type: 'custom_header', credential: 'replacement', headerName: 'X-Registry-Key'
      }
    });

    assert.deepEqual(body.auth, {
      type: 'custom_header', credential: 'replacement', header_name: 'X-Registry-Key'
    });
  });
});
