import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { config } from '../src/config.js';
import {
  completeMcpOAuthCallback,
  getMcpOAuthClientMetadata,
  prepareMcpOAuthConnection,
  startMcpOAuthConnection
} from '../src/controllers/mcp-oauth-controller.js';
import { repo } from '../src/store/repository.js';
import {
  callController,
  createRequest,
  createResponse,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

const previousOAuthEnabled = config.MCP_OAUTH_ENABLED;

function oauthServer() {
  return {
    id: 'server-agent-1',
    workspace_id: 'workspace-1',
    scope_type: 'agent',
    agent_id: 'agent-1',
    server_name: 'GitLab',
    server_url: 'https://gitlab.example/api/v4/mcp',
    enabled: true,
    auth_type: 'oauth',
    credential_mode: 'individual',
    tools: []
  };
}

beforeEach(() => {
  config.MCP_OAUTH_ENABLED = true;
  installWorkspace('operator');
});

afterEach(() => {
  config.MCP_OAUTH_ENABLED = previousOAuthEnabled;
  restoreControllerRegressionState();
});

describe('MCP OAuth controllers', () => {
  it('prepares an individual OAuth installation and binds it to the browser', async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    mock.method(globalThis, 'fetch', async (input, init) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (init?.method === 'GET') {
        return new Response(JSON.stringify([oauthServer()]), { status: 200 });
      }
      return new Response(JSON.stringify({
        preparation_handle: 'p'.repeat(43),
        resource_origin: 'https://gitlab.example',
        issuer_selection_required: false,
        candidates: [{
          issuer: 'https://gitlab.example',
          issuer_origin: 'https://gitlab.example',
          registration_method: 'dcr',
          scopes: ['mcp:tools', 'offline_access'],
          offline_access_requested: true
        }]
      }), { status: 200 });
    });

    const response = await callController(
      prepareMcpOAuthConnection,
      createRequest(
        { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
        { returnPath: '/workspaces/workspace-1/agents/agent-1/mcp' }
      )
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.cookies.size, 1);
    const forwarded = requests[1].body || {};
    assert.equal(forwarded.workspace_id, 'workspace-1');
    assert.equal(forwarded.owner_id, 'user-1');
    assert.match(String(forwarded.browser_binding_hash), /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(forwarded).includes('credential'), false);
    assert.deepEqual(response.body, {
      preparationHandle: 'p'.repeat(43),
      resourceOrigin: 'https://gitlab.example',
      issuerSelectionRequired: false,
      candidates: [{
        issuer: 'https://gitlab.example',
        issuerOrigin: 'https://gitlab.example',
        registrationMethod: 'dcr',
        scopes: ['mcp:tools', 'offline_access'],
        offlineAccessRequested: true
      }]
    });
  });

  it('requires explicit consent and an existing browser binding before start', async () => {
    const gateway = mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'GET') {
        return new Response(JSON.stringify([oauthServer()]), { status: 200 });
      }
      throw new Error('start must not reach the gateway without a browser binding');
    });

    const response = await callController(
      startMcpOAuthConnection,
      createRequest(
        { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
        { preparationHandle: 'p'.repeat(43), consentGranted: true }
      )
    );

    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      'MCP_OAUTH_BROWSER_BINDING_REQUIRED'
    );
    assert.equal(gateway.mock.callCount(), 1);
  });

  it('audits explicit issuer selection and accepted metadata changes without URLs', async () => {
    const audits: Array<{ eventType: string; metadata?: unknown }> = [];
    repo.insertWorkspaceAuditEvent = async (event) => {
      audits.push({ eventType: event.eventType, metadata: event.metadata });
      return {
        id: 'audit-1',
        workspaceId: event.workspaceId,
        category: event.category,
        eventType: event.eventType,
        actor: { type: 'user', userId: event.actorUserId },
        object: { type: event.objectType, id: event.objectId },
        summary: event.summary,
        metadata: event.metadata ?? {},
        occurredAt: '2026-07-29T00:00:00.000Z'
      };
    };
    mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'GET') {
        return new Response(JSON.stringify([oauthServer()]), { status: 200 });
      }
      return new Response(JSON.stringify({
        authorization_url: 'https://auth.example/authorize?opaque=1',
        metadata_changed: true
      }), { status: 200 });
    });
    const request = createRequest(
      { workspaceId: 'workspace-1', agentId: 'agent-1', serverId: 'server-agent-1' },
      {
        preparationHandle: 'p'.repeat(43),
        issuer: 'https://auth.example/realms/acornops',
        consentGranted: true
      }
    );
    request.cookies['acornops-mcp-oauth-binding'] = 'b'.repeat(43);

    const response = await callController(startMcpOAuthConnection, request);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      audits.map((event) => event.eventType),
      [
        'mcp.oauth_issuer_selected.v1',
        'mcp.oauth_metadata_changed.v1',
        'mcp.oauth_started.v1'
      ]
    );
    assert.equal(JSON.stringify(audits).includes('auth.example'), false);
  });

  it('publishes a secret-free CIMD document from canonical configuration', () => {
    const response = createResponse();
    getMcpOAuthClientMetadata({} as never, response as never);

    assert.equal(response.statusCode, 200);
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes('client_secret'), false);
    assert.equal(serialized.includes('workspace'), false);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(
      (response.body as { redirect_uris: string[] }).redirect_uris,
      [`${config.MANAGEMENT_CONSOLE_BASE_URL}/api/v1/mcp/oauth/callback`]
    );
  });

  it('completes the callback using the canonical console origin, not request headers', async () => {
    const binding = 'b'.repeat(43);
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      connection: {
        server_id: 'server-agent-1',
        credential_mode: 'individual',
        status: 'connected',
        auth_type: 'oauth',
        registration_method: 'cimd',
        scopes: ['mcp:tools'],
        refresh_capable: true
      },
      return_path: '/workspaces/workspace-1/agents/agent-1/mcp',
      workspace_id: 'workspace-1',
      server_id: 'server-agent-1'
    }), { status: 200 }));
    const request = createRequest({});
    request.query = {
      state: 's'.repeat(43),
      code: 'authorization-code',
      iss: 'https://auth.example'
    } as never;
    request.cookies['acornops-mcp-oauth-binding'] = binding;
    Object.assign(request, {
      headers: { host: 'attacker.example' }
    });

    const response = await callController(completeMcpOAuthCallback, request);

    assert.equal(response.statusCode, 303);
    const redirect = new URL(response.redirectLocation || '');
    assert.equal(redirect.origin, new URL(config.MANAGEMENT_CONSOLE_BASE_URL).origin);
    assert.equal(redirect.pathname, '/workspaces/workspace-1/agents/agent-1/mcp');
    assert.equal(redirect.searchParams.get('mcpOAuthResult'), 'connected');
  });

  it('returns a stable callback error without forwarding provider descriptions', async () => {
    const binding = 'b'.repeat(43);
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      detail: {
        code: 'MCP_OAUTH_AUTHORIZATION_DENIED',
        message: 'Authorization was denied.',
        retryable: false,
        return_path: '/workspaces/workspace-1/agents/agent-1/mcp',
        workspace_id: 'workspace-1',
        server_id: 'server-agent-1'
      }
    }), { status: 409 }));
    const request = createRequest({});
    request.query = {
      state: 's'.repeat(43),
      error: 'access_denied',
      error_description: 'sensitive provider text'
    } as never;
    request.cookies['acornops-mcp-oauth-binding'] = binding;

    const response = await callController(completeMcpOAuthCallback, request);

    assert.equal(response.statusCode, 303);
    assert.equal(
      new URL(response.redirectLocation || '').searchParams.get('mcpOAuthResult'),
      'MCP_OAUTH_AUTHORIZATION_DENIED'
    );
    assert.equal((response.redirectLocation || '').includes('sensitive'), false);
  });

  it('preserves a sanitized MCP verification result after OAuth completion', async () => {
    const binding = 'b'.repeat(43);
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      detail: {
        code: 'MCP_ENDPOINT_NOT_FOUND',
        message: 'provider response must not be forwarded',
        retryable: false,
        return_path: '/workspaces/workspace-1/agents/agent-1/mcp',
        workspace_id: 'workspace-1',
        server_id: 'server-agent-1'
      }
    }), { status: 409 }));
    const request = createRequest({});
    request.query = {
      state: 's'.repeat(43),
      code: 'authorization-code'
    } as never;
    request.cookies['acornops-mcp-oauth-binding'] = binding;

    const response = await callController(completeMcpOAuthCallback, request);

    assert.equal(response.statusCode, 303);
    assert.equal(
      new URL(response.redirectLocation || '').searchParams.get('mcpOAuthResult'),
      'MCP_ENDPOINT_NOT_FOUND'
    );
    assert.equal((response.redirectLocation || '').includes('provider'), false);
  });

  it('rejects a callback containing both an authorization code and an error', async () => {
    const gateway = mock.method(globalThis, 'fetch', async () => {
      throw new Error('an ambiguous callback must not reach the gateway');
    });
    const request = createRequest({});
    request.query = {
      state: 's'.repeat(43),
      code: 'authorization-code',
      error: 'access_denied'
    } as never;
    request.cookies['acornops-mcp-oauth-binding'] = 'b'.repeat(43);

    const response = await callController(completeMcpOAuthCallback, request);

    assert.equal(response.statusCode, 303);
    assert.equal(
      new URL(response.redirectLocation || '').searchParams.get('mcpOAuthResult'),
      'MCP_OAUTH_CALLBACK_INVALID'
    );
    assert.equal(gateway.mock.callCount(), 0);
  });
});
