import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { genericMcpAuthRequirements } from '../src/controllers/workflow-capability-preview-controller.js';

afterEach(() => mock.restoreAll());

describe('workflow capability preview controller safety', () => {
  it('returns bounded credential requirements without installation secrets or endpoint details', async () => {
    mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/servers?')) {
        return new Response(JSON.stringify([{
          id: 'server-1', workspace_id: 'workspace-1', scope_type: 'agent', agent_id: 'agent-1',
          server_name: 'private-catalog', server_url: 'https://secret.internal.example/mcp',
          enabled: true, auth_type: 'custom_header', credential_mode: 'workspace',
          auth_header_name: 'x-private-token', public_headers: { 'x-private': 'value' }, tools: []
        }]), { status: 200 });
      }
      if (url.includes('/connections/installation?')) {
        return new Response(JSON.stringify({
          server_id: 'server-1', credential_mode: 'workspace', status: 'missing',
          auth_type: 'custom_header', action: 'connect_mcp_server'
        }), { status: 200 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const result = await genericMcpAuthRequirements({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      agents: [{ id: 'agent-1', name: 'Catalog Agent' }] as never,
      scope: { mcpServers: ['server-1'] } as never
    });

    assert.deepEqual(result, [{
      serverId: 'server-1',
      serverName: 'private-catalog',
      authType: 'custom_header',
      owningAgent: { id: 'agent-1', name: 'Catalog Agent' },
      connectionState: 'connection_missing',
      authRequirement: {
        scope: 'workspace',
        credentialLabel: 'Custom header credential',
        requiredInformation: [{
          name: 'Custom header credential',
          description: 'Provide a service or bot credential for private-catalog. Authorized users and automations, including service identities, will use it.'
        }]
      },
      action: 'connect_mcp_server'
    }]);
    const serialized = JSON.stringify(result);
    for (const sensitive of ['secret.internal.example', 'x-private-token', 'x-private', 'credentialValue']) {
      assert.equal(serialized.includes(sensitive), false);
    }
  });
});
