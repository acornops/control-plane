import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  createTargetMcpServerForTarget,
  deleteTargetMcpServerForTarget,
  updateTargetMcpServerForTarget,
  updateTargetMcpServerToolSettings
} from '../src/controllers/workspaces/target-tool-controller.js';
import {
  parseTargetMcpServerCreate,
  parseTargetMcpServerUpdate,
  targetMcpToolSettingsSchema
} from '../src/controllers/workspaces/target-mcp-helpers.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';

afterEach(restoreControllerRegressionState);

describe('target MCP controller regressions', () => {
  it('rejects unsafe endpoints and public/auth header collisions before any gateway call', async () => {
    installWorkspace('admin');
    const gateway = mock.method(globalThis, 'fetch', async () => new Response('unexpected request', { status: 500 }));

    const unsafeEndpoint = await callController(createTargetMcpServerForTarget, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1' },
      { name: 'unsafe', url: 'https://mcp.example.test/rpc?token=secret' }
    ));
    const collidingHeader = await callController(createTargetMcpServerForTarget, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1' },
      {
        name: 'collision',
        url: 'https://mcp.example.test/rpc',
        publicHeaders: { 'X-Company': 'acornops' },
        credentialMode: 'workspace',
        auth: { type: 'custom_header', headerName: 'x-company' }
      }
    ));
    const reservedAuthHeader = await callController(createTargetMcpServerForTarget, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1' },
      {
        name: 'reserved-auth-header',
        url: 'https://mcp.example.test/rpc',
        credentialMode: 'workspace',
        auth: { type: 'custom_header', headerName: 'mcp-session-id' }
      }
    ));
    const injectedAuthPrefix = await callController(createTargetMcpServerForTarget, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1' },
      {
        name: 'injected-auth-prefix',
        url: 'https://mcp.example.test/rpc',
        credentialMode: 'workspace',
        auth: {
          type: 'custom_header',
          headerName: 'X-Company',
          headerPrefix: 'Token \r\nx-injected: true'
        }
      }
    ));

    assert.deepEqual([
      unsafeEndpoint.statusCode,
      collidingHeader.statusCode,
      reservedAuthHeader.statusCode,
      injectedAuthPrefix.statusCode
    ], [400, 400, 400, 400]);
    assert.ok([
      unsafeEndpoint,
      collidingHeader,
      reservedAuthHeader,
      injectedAuthPrefix
    ].every((response) => (
      (response.body as { error: { code: string } }).error.code === 'VALIDATION_ERROR'
    )));
    assert.equal(gateway.mock.callCount(), 0);
  });

  it('rejects malformed and unknown mutation fields', () => {
    assert.equal(parseTargetMcpServerCreate({
      name: 'server', url: 'https://mcp.example.test', auth: { type: 'unsupported' }
    }).success, false);
    assert.equal(parseTargetMcpServerCreate({
      name: 'server', url: 'https://mcp.example.test', credential: 'secret'
    }).success, false);
    assert.equal(parseTargetMcpServerUpdate({ enabled: 'false' }).success, false);
    assert.equal(parseTargetMcpServerUpdate({ ignored: true }).success, false);
    assert.equal(parseTargetMcpServerUpdate({ url: 'https://replacement.example.test' }).success, false);
    assert.equal(parseTargetMcpServerUpdate({ tools: [{ name: 'unexpected.tool' }] }).success, false);
    assert.equal(targetMcpToolSettingsSchema.safeParse({ enabled: false, ignored: true }).success, false);
  });

  it('keeps built-in definitions immutable', async () => {
    installWorkspace('admin');
    const server = {
      id: 'builtin-server', workspace_id: 'workspace-1', scope_type: 'target',
      target_id: 'cluster-1', target_type: 'kubernetes', server_name: 'AcornOps',
      server_url: 'http://control-plane:8081/internal/v1/mcp', enabled: true,
      auth_type: 'none', credential_mode: 'none', provenance_type: 'builtin', revision: 1, tools: []
    };
    const tool = {
      name: 'get_resource', server_id: 'builtin-server', mcp_server_url: server.server_url,
      timeout_ms: 10_000, enabled: true, source: 'builtin', capability: 'read'
    };
    const gateway = mock.method(globalThis, 'fetch', async (input) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/servers?')) return Response.json([server]);
      if (url.includes('/api/v1/internal/mcp/tools?')) return Response.json([tool]);
      return new Response('unexpected mutation', { status: 500 });
    });

    const renamed = await callController(updateTargetMcpServerForTarget, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1', serverId: 'builtin-server' },
      { name: 'renamed' }
    ));
    const removed = await callController(deleteTargetMcpServerForTarget, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1', serverId: 'builtin-server' }
    ));
    const redefinedTool = await callController(updateTargetMcpServerToolSettings, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1', serverId: 'builtin-server', toolName: 'get_resource' },
      { enabled: true, capability: 'write' }
    ));

    assert.deepEqual([renamed.statusCode, removed.statusCode, redefinedTool.statusCode], [409, 409, 409]);
    assert.ok([renamed, removed, redefinedTool].every((response) => (
      (response.body as { error: { code: string } }).error.code === 'BUILTIN_MCP_SERVER_MANAGED'
    )));
    assert.ok(gateway.mock.calls.every((call) => call.arguments[1]?.method === 'GET'));
  });

  it('rejects incomplete effective auth transitions before gateway mutation', async () => {
    installWorkspace('admin');
    const server = {
      id: 'manual-server', workspace_id: 'workspace-1', scope_type: 'target',
      target_id: 'cluster-1', target_type: 'kubernetes', server_name: 'Remote',
      server_url: 'https://mcp.example.test', enabled: true, auth_type: 'none',
      credential_mode: 'none', provenance_type: 'manual', revision: 1, tools: []
    };
    const gateway = mock.method(globalThis, 'fetch', async () => Response.json([server]));

    const response = await callController(updateTargetMcpServerForTarget, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1', serverId: 'manual-server' },
      { auth: { type: 'bearer_token' } }
    ));

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { code: string } }).error.code, 'MCP_AUTH_CONFIG_INVALID');
    assert.ok(gateway.mock.calls.every((call) => call.arguments[1]?.method === 'GET'));
  });

  it('updates tools by server identity when legacy URL metadata is stale', async () => {
    installWorkspace('admin');
    const server = {
      id: 'manual-server', workspace_id: 'workspace-1', scope_type: 'target',
      target_id: 'cluster-1', target_type: 'kubernetes', server_name: 'Remote',
      server_url: 'https://current.example.test/mcp', enabled: true, auth_type: 'none',
      credential_mode: 'none', provenance_type: 'manual', revision: 1, tools: []
    };
    const tool = {
      name: 'records.list', server_id: 'manual-server',
      mcp_server_url: 'https://stale.example.test/mcp', timeout_ms: 10_000,
      enabled: false, source: 'mcp', capability: 'read'
    };
    let patchCount = 0;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        patchCount += 1;
        return Response.json({ ...tool, enabled: true });
      }
      if (url.includes('/api/v1/internal/mcp/servers?')) return Response.json([server]);
      if (url.includes('/api/v1/internal/mcp/tools?')) return Response.json([tool]);
      return new Response('unexpected request', { status: 500 });
    });

    const response = await callController(updateTargetMcpServerToolSettings, createRequest(
      { workspaceId: 'workspace-1', targetId: 'cluster-1', serverId: 'manual-server', toolName: 'records.list' },
      { enabled: true, capability: 'read' }
    ));

    assert.equal(response.statusCode, 200);
    assert.equal(patchCount, 1);
  });
});
