import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  patchServer,
  patchTool,
  removeServer
} from '../src/controllers/agent-mcp-controller.js';
import {
  callController,
  createRequest,
  installWorkspace,
  restoreControllerRegressionState
} from './helpers/controller-regression-fixtures.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from './helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures(['workspace-1']);
  installWorkspace('admin');
});
afterEach(() => {
  mock.restoreAll();
  restoreControllerRegressionState();
});
after(closeAutomationDatabaseFixtures);

function builtinServer(enabled = true, revision = 1) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspace_id: 'workspace-1',
    scope_type: 'agent',
    agent_id: 'agent-cluster-triage',
    target_id: 'agent-cluster-triage',
    target_type: 'agent',
    server_name: 'acornops-targets',
    server_url: 'http://control-plane:8081/internal/v1/mcp',
    enabled,
    auth_type: 'none',
    credential_mode: 'none',
    provenance_type: 'builtin',
    revision,
    tools: [{
      name: 'list_targets',
      server_id: '11111111-1111-4111-8111-111111111111',
      model_alias: 'targets_list_targets',
      mcp_server_url: 'http://control-plane:8081/internal/v1/mcp',
      timeout_ms: 10_000,
      capability: 'read',
      source: 'builtin',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      artifact_policy: 'never',
      enabled: true,
      review_state: 'approved',
      risk_level: 'read_only',
      auto_allowed: false
    }]
  };
}

function params() {
  return {
    workspaceId: 'workspace-1',
    agentId: 'agent-cluster-triage',
    serverId: '11111111-1111-4111-8111-111111111111'
  };
}

describe('Agent Targets MCP management boundary', () => {
  it('rejects connection, deletion, and no-op revision mutations', async () => {
    const gateway = mock.method(globalThis, 'fetch', async () => Response.json([builtinServer()]));

    const renamed = await callController(patchServer, createRequest(params(), { name: 'renamed' }));
    const revisionOnly = await callController(patchServer, createRequest(params(), { expectedRevision: 1 }));
    const removed = await callController(removeServer, createRequest(params()));
    assert.equal(renamed.statusCode, 409);
    assert.equal(revisionOnly.statusCode, 409);
    assert.equal(removed.statusCode, 409);
    assert.ok([
      renamed,
      revisionOnly,
      removed
    ].every((response) => (
      (response.body as { error: { code: string } }).error.code === 'BUILTIN_MCP_SERVER_MANAGED'
    )));
    assert.ok(gateway.mock.calls.every((call) => call.arguments[1]?.method === 'GET'));
  });

  it('allows toggling each managed Targets tool', async () => {
    const source = builtinServer().tools[0];
    const gateway = mock.method(globalThis, 'fetch', async (input, init) => {
      if (init?.method === 'PATCH' && String(input).includes('/tools/')) {
        return Response.json({ ...source, enabled: false });
      }
      return Response.json([builtinServer()]);
    });

    const response = await callController(patchTool, createRequest(
      { ...params(), toolName: 'list_targets' },
      { enabled: false }
    ));

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { tool: { enabled: boolean } }).tool.enabled, false);
    assert.equal(gateway.mock.calls.filter((call) => call.arguments[1]?.method === 'PATCH').length, 1);
  });

  it('allows toggling the server as one managed capability', async () => {
    let current = builtinServer();
    const gateway = mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { enabled?: boolean };
        current = builtinServer(body.enabled ?? current.enabled, current.revision + 1);
        return Response.json(current);
      }
      return Response.json([current]);
    });

    const response = await callController(patchServer, createRequest(params(), {
      enabled: false,
      expectedRevision: 1
    }));

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { server: { enabled: boolean } }).server.enabled, false);
    assert.equal(gateway.mock.calls.filter((call) => call.arguments[1]?.method === 'PATCH').length, 1);
  });
});
