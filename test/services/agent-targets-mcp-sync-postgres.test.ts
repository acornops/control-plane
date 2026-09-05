import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { syncAgentTargetsBuiltInTools } from '../../src/services/agent-targets-mcp-sync.js';
import { AGENT_TARGETS_MCP_SERVER_NAME } from '../../src/services/agent-targets-mcp-catalog.js';
import { getAgentDefinition, updateAgentDefinition } from '../../src/store/repository-agents.js';
import {
  closeAutomationDatabaseFixtures,
  installAutomationTemplateFixtures,
  resetAutomationDatabaseFixtures
} from '../helpers/automation-database-fixtures.js';

beforeEach(async () => {
  await resetAutomationDatabaseFixtures();
  await installAutomationTemplateFixtures(['workspace-1']);
});
afterEach(() => {
  mock.restoreAll();
});
after(closeAutomationDatabaseFixtures);

describe('Agent Targets MCP synchronization', () => {
  it('treats a gateway lifecycle fence as a terminal no-resync result', async () => {
    const gateway = mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v1/internal/mcp/servers?') && init?.method === 'GET') {
        return Response.json({ detail: {
          code: 'MCP_LIFECYCLE_FENCED',
          message: 'MCP lifecycle teardown is in progress for this destination.',
          retryable: false
        } }, { status: 409 });
      }
      return new Response('unexpected request', { status: 500 });
    });

    const result = await syncAgentTargetsBuiltInTools('workspace-1', 'agent-cluster-triage');

    assert.equal(result.ok, false);
    assert.equal(result.terminal, true);
    assert.equal(result.error, 'MCP_LIFECYCLE_FENCED');
    assert.ok(gateway.mock.calls.every((call) => call.arguments[1]?.method === 'GET'));
  });

  it('creates one built-in Agent server and snapshots its three tools', async () => {
    const before = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
    assert.ok(before);
    let server = {
      id: '11111111-1111-4111-8111-111111111111',
      workspace_id: 'workspace-1',
      scope_type: 'agent',
      agent_id: 'agent-cluster-triage',
      server_name: AGENT_TARGETS_MCP_SERVER_NAME,
      server_url: 'http://control-plane:8081/internal/v1/mcp',
      enabled: true,
      auth_type: 'none',
      credential_mode: 'none',
      auth_header_name: null as string | null,
      auth_header_prefix: null as string | null,
      public_headers: null as Record<string, string> | null,
      provenance_type: 'builtin',
      revision: 1,
      tools: [
        ['list_targets', 'm_targets_list_targets_1'],
        ['get_target', 'm_targets_get_target_1'],
        ['list_target_issues', 'm_targets_list_target_issues_1']
      ].map(([name, alias]) => ({
        name,
        server_id: '11111111-1111-4111-8111-111111111111',
        model_alias: alias,
        mcp_server_url: 'http://control-plane:8081/internal/v1/mcp',
        timeout_ms: 10_000,
        capability: 'read',
        version: 'v1',
        source: 'builtin',
        input_schema: {},
        output_schema: {},
        artifact_policy: 'never',
        enabled: true,
        review_state: 'approved',
        risk_level: 'read_only',
        auto_allowed: false
      }))
    };
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    let listCount = 0;
    mock.method(globalThis, 'fetch', async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined;
      requests.push({ url, method, body });
      if (url.includes('/api/v1/internal/mcp/tools?') && method === 'GET') {
        return Response.json([{
          name: 'list_resources',
          server_id: '22222222-2222-4222-8222-222222222222',
          model_alias: 'list_resources',
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
        }]);
      }
      if (url.includes('/api/v1/internal/mcp/servers?') && method === 'GET') {
        listCount += 1;
        return Response.json(listCount === 1 ? [] : [server]);
      }
      if (url.endsWith('/api/v1/internal/mcp/servers/builtin') && method === 'PUT') {
        const requestedTools = body?.tools as Array<Record<string, unknown>>;
        const aliases = new Map(server.tools.map((tool) => [tool.name, tool.model_alias]));
        server = {
          ...server,
          server_name: String(body?.server_name),
          server_url: 'http://control-plane:8081/internal/v1/mcp',
          auth_type: 'none',
          credential_mode: 'none',
          auth_header_name: null,
          auth_header_prefix: null,
          public_headers: {},
          revision: listCount === 1 ? server.revision : server.revision + 1,
          tools: requestedTools.map((tool, index) => ({
            ...tool,
            server_id: server.id,
            model_alias: aliases.get(String(tool.name)) || server.tools[index]?.model_alias || String(tool.name),
            mcp_server_url: server.server_url
          }))
        };
        return Response.json(server);
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    });

    const result = await syncAgentTargetsBuiltInTools('workspace-1', 'agent-cluster-triage');

    assert.equal(result.ok, true);
    assert.equal(result.registeredToolCount, 3);
    const create = requests.find((request) => request.method === 'PUT');
    assert.ok(create);
    assert.equal(create.body?.scope_type, 'agent');
    assert.equal(create.body?.agent_id, 'agent-cluster-triage');
    assert.equal(create.body?.server_name, AGENT_TARGETS_MCP_SERVER_NAME);
    assert.equal(create.body?.configuration_attested, undefined);
    assert.deepEqual(
      (create.body?.tools as Array<{ name: string }>).map((tool) => tool.name),
      ['list_targets', 'get_target', 'list_target_issues']
    );
    const synced = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
    assert.notEqual(synced?.updatedAt, before.updatedAt);
    assert.deepEqual(synced?.mcpServers, [server.id]);
    assert.deepEqual(
      synced?.mcpInstallations[0]?.tools.map((tool) => tool.toolName),
      ['list_targets', 'get_target', 'list_target_issues']
    );
    assert.equal(synced?.readiness.status, 'ready');

    const syncCountBeforeNoOp = requests.filter((request) => request.method === 'PUT').length;
    const noOp = await syncAgentTargetsBuiltInTools('workspace-1', 'agent-cluster-triage');
    assert.equal(noOp.ok, true);
    assert.equal(noOp.agent?.updatedAt, synced?.updatedAt);
    assert.equal(
      requests.filter((request) => request.method === 'PUT').length,
      syncCountBeforeNoOp
    );

    const drifted = await updateAgentDefinition('workspace-1', 'agent-cluster-triage', {
      mcpInstallations: synced!.mcpInstallations.map((installation) => ({
        ...installation,
        name: 'stale-targets-name'
      }))
    });
    assert.ok(drifted);
    const driftRepair = await syncAgentTargetsBuiltInTools('workspace-1', 'agent-cluster-triage');
    assert.equal(driftRepair.ok, true);
    assert.notEqual(driftRepair.agent?.updatedAt, drifted.updatedAt);
    assert.equal(driftRepair.agent?.mcpInstallations[0]?.name, AGENT_TARGETS_MCP_SERVER_NAME);
    assert.equal(
      requests.filter((request) => request.method === 'PUT').length,
      syncCountBeforeNoOp
    );

    server.tools.push({
      ...server.tools[0],
      name: 'rogue_tool',
      model_alias: 'rogue_tool',
      source: 'mcp'
    });
    const repaired = await syncAgentTargetsBuiltInTools('workspace-1', 'agent-cluster-triage');
    assert.equal(repaired.ok, true);
    assert.deepEqual(repaired.removedTools, ['rogue_tool']);
    const repairRequest = requests.filter((request) => request.method === 'PUT').at(-1);
    assert.equal(repairRequest?.body?.server_id, server.id);
    assert.equal(
      (repairRequest?.body?.tools as Array<{ name: string }>).some((tool) => tool.name === 'rogue_tool'),
      false
    );

    Object.assign(server, {
      auth_type: 'bearer_token',
      credential_mode: 'workspace',
      auth_header_name: 'Authorization',
      auth_header_prefix: 'Bearer ',
      public_headers: { 'x-unexpected': 'drift' }
    });
    const authRepair = await syncAgentTargetsBuiltInTools('workspace-1', 'agent-cluster-triage');
    assert.equal(authRepair.ok, true);
    const authRepairRequest = requests.filter((request) => request.method === 'PUT').at(-1);
    assert.equal(authRepairRequest?.body?.server_id, server.id);
    assert.equal(authRepairRequest?.body?.auth_type, undefined);
    assert.equal(authRepairRequest?.body?.credential_mode, undefined);
    assert.equal(authRepairRequest?.body?.public_headers, undefined);
    assert.equal(server.auth_type, 'none');
    assert.equal(server.credential_mode, 'none');
    assert.equal(server.auth_header_name, null);
    assert.equal(server.auth_header_prefix, null);
    assert.deepEqual(server.public_headers, {});
  });
});
