import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  createServer,
  patchServer,
  patchTool,
  removeServer
} from '../src/controllers/agent-mcp-controller.js';
import {
  getTargetAccess,
  putTargetAccess
} from '../src/controllers/agent-target-access-controller.js';
import { config } from '../src/config.js';
import { db } from '../src/infra/db.js';
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
  await db.query(
    `UPDATE agent_definitions
     SET mcp_installations=$1
     WHERE workspace_id='workspace-1' AND id='agent-cluster-triage'`,
    [JSON.stringify([{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'AcornOps Targets',
      url: config.BUILTIN_TARGET_MCP_SERVER_URL
    }])]
  );
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

function manualServer(overrides: Record<string, unknown> = {}) {
  return {
    ...builtinServer(),
    server_name: 'external-agent-mcp',
    server_url: 'https://mcp.example.test/server',
    provenance_type: 'manual',
    ...overrides
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
  it('preserves OAuth and public headers when creating an Agent MCP server', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const created = manualServer({
      auth_type: 'oauth',
      credential_mode: 'individual',
      public_headers: { 'x-client-version': '2026-08' }
    });
    mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'POST') {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json(created);
      }
      return Response.json([created]);
    });

    const response = await callController(createServer, createRequest(params(), {
      name: 'external-agent-mcp',
      url: 'https://mcp.example.test/server',
      authType: 'oauth',
      credentialMode: 'individual',
      publicHeaders: { 'x-client-version': '2026-08' }
    }));

    assert.equal(response.statusCode, 201);
    assert.equal(requestBody?.auth_type, 'oauth');
    assert.equal(requestBody?.credential_mode, 'individual');
    assert.deepEqual(requestBody?.public_headers, { 'x-client-version': '2026-08' });
    assert.equal((response.body as { server: { authType: string } }).server.authType, 'oauth');
  });

  it('preserves OAuth and public headers when updating an Agent MCP server', async () => {
    let current = manualServer();
    let requestBody: Record<string, unknown> | undefined;
    mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'PATCH') {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        current = manualServer({
          auth_type: requestBody.auth_type,
          credential_mode: requestBody.credential_mode,
          public_headers: requestBody.public_headers,
          revision: 2
        });
        return Response.json(current);
      }
      return Response.json([current]);
    });

    const response = await callController(patchServer, createRequest(params(), {
      authType: 'oauth',
      credentialMode: 'individual',
      publicHeaders: { 'x-client-version': '2026-08' },
      expectedRevision: 1
    }));

    assert.equal(response.statusCode, 200);
    assert.equal(requestBody?.auth_type, 'oauth');
    assert.equal(requestBody?.credential_mode, 'individual');
    assert.deepEqual(requestBody?.public_headers, { 'x-client-version': '2026-08' });
    assert.equal((response.body as { server: { authType: string } }).server.authType, 'oauth');
  });

  it('reads and persists normalized Agent target access', async () => {
    const initial = await callController(getTargetAccess, createRequest(params()));
    assert.equal(initial.statusCode, 200);
    assert.deepEqual((initial.body as { policy: unknown }).policy, { mode: 'all', targetIds: [] });
    assert.deepEqual(
      (initial.body as { targets: Array<{ id: string }> }).targets.map((target) => target.id),
      ['cluster-1']
    );

    const updated = await callController(putTargetAccess, createRequest(params(), {
      mode: 'allowlist',
      targetIds: [' cluster-1 ', 'cluster-1']
    }));
    assert.equal(updated.statusCode, 200);
    assert.deepEqual((updated.body as { policy: unknown }).policy, {
      mode: 'allowlist',
      targetIds: ['cluster-1']
    });

    const persisted = await db.query<{ target_access_policy: unknown }>(
      `SELECT target_access_policy
       FROM agent_definitions
       WHERE workspace_id='workspace-1' AND id='agent-cluster-triage'`
    );
    assert.deepEqual(persisted.rows[0].target_access_policy, {
      mode: 'allowlist',
      targetIds: ['cluster-1']
    });
  });

  it('rejects target IDs outside the Agent workspace', async () => {
    const response = await callController(putTargetAccess, createRequest(params(), {
      mode: 'denylist',
      targetIds: ['cluster-2']
    }));
    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      'AGENT_TARGET_ACCESS_TARGET_INVALID'
    );
  });

  it('omits deleted target IDs from the effective settings response', async () => {
    await db.query(
      `UPDATE agent_definitions
       SET target_access_policy=$1
       WHERE workspace_id='workspace-1' AND id='agent-cluster-triage'`,
      [JSON.stringify({ mode: 'denylist', targetIds: ['cluster-1', 'deleted-target'] })]
    );

    const response = await callController(getTargetAccess, createRequest(params()));
    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as { policy: unknown }).policy, {
      mode: 'denylist',
      targetIds: ['cluster-1']
    });
  });

  it('allows workspace readers to inspect settings but not update them', async () => {
    installWorkspace('viewer');
    const read = await callController(getTargetAccess, createRequest(params()));
    const write = await callController(putTargetAccess, createRequest(params(), {
      mode: 'all',
      targetIds: []
    }));
    assert.equal(read.statusCode, 200);
    assert.equal(write.statusCode, 403);
  });

  it('rejects unknown policy fields', async () => {
    const response = await callController(putTargetAccess, createRequest(params(), {
      mode: 'all',
      targetIds: [],
      workflowId: 'workflow-1'
    }));
    assert.equal(response.statusCode, 400);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      'AGENT_TARGET_ACCESS_INVALID'
    );
  });

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
