import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { syncAgentTargetsBuiltInTools } from '../../src/services/agent-targets-mcp-sync.js';
import { getAgentDefinition, updateAgentDefinition } from '../../src/store/repository-agents.js';
import {
  createCapabilityRoutingMapping,
  listCapabilityRoutingMappings
} from '../../src/store/repository-capability-routing.js';
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
  it('creates one built-in Agent server and snapshots its three tools', async () => {
    const before = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
    assert.ok(before);
    const mappingsBefore = (await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true }))
      .filter((mapping) => mapping.agentId === before.id && mapping.agentVersion === before.version);
    assert.ok(mappingsBefore.length > 0);
    const staleMapping = await createCapabilityRoutingMapping({
      workspaceId: before.workspaceId,
      capabilityId: 'test.stale.mapping',
      agentId: before.id,
      agentVersion: before.version + 100,
      status: 'active',
      reviewState: 'reviewed',
      priority: 999,
      targetTypes: [],
      targetIds: [],
      mcpTools: [],
      nativeToolIds: [],
      skillIds: [],
      contextGrants: [],
      createdBy: 'user-1',
      reviewedBy: 'user-1'
    });
    let server = {
      id: '11111111-1111-4111-8111-111111111111',
      workspace_id: 'workspace-1',
      scope_type: 'agent',
      agent_id: 'agent-cluster-triage',
      target_id: 'agent-cluster-triage',
      target_type: 'agent',
      target_constraints: {
        target_types: ['kubernetes', 'virtual_machine'],
        target_ids: []
      },
      server_name: 'acornops-targets',
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
      if (url.endsWith('/api/v1/internal/mcp/servers') && method === 'POST') {
        const requestedTools = body?.tools as Array<Record<string, unknown>>;
        const requestedConstraints = body?.target_constraints as {
          target_types: string[];
          target_ids: string[];
        };
        server = {
          ...server,
          target_constraints: requestedConstraints,
          tools: requestedTools.map((tool, index) => ({
            ...tool,
            server_id: server.id,
            model_alias: server.tools[index].model_alias,
            mcp_server_url: server.server_url
          }))
        };
        return Response.json(server, { status: 201 });
      }
      if (url.includes(`/api/v1/internal/mcp/servers/${server.id}?`) && method === 'PATCH') {
        const removeTools = new Set((body?.remove_tools || []) as string[]);
        const requestedTools = body?.tools as Array<Record<string, unknown>> | undefined;
        const aliases = new Map(server.tools.map((tool) => [tool.name, tool.model_alias]));
        server = {
          ...server,
          server_name: typeof body?.server_name === 'string' ? body.server_name : server.server_name,
          server_url: typeof body?.server_url === 'string' ? body.server_url : server.server_url,
          auth_type: typeof body?.auth_type === 'string' ? body.auth_type : server.auth_type,
          credential_mode: typeof body?.credential_mode === 'string'
            ? body.credential_mode
            : server.credential_mode,
          auth_header_name: body?.auth_type === 'none' ? null : server.auth_header_name,
          auth_header_prefix: body?.auth_type === 'none' ? null : server.auth_header_prefix,
          public_headers: body?.public_headers !== undefined
            ? body.public_headers as Record<string, string>
            : server.public_headers,
          target_constraints: body?.target_constraints
            ? body.target_constraints as typeof server.target_constraints
            : server.target_constraints,
          revision: server.revision + 1,
          tools: requestedTools
            ? requestedTools.map((tool) => ({
                ...tool,
                server_id: server.id,
                model_alias: aliases.get(String(tool.name)) || String(tool.name),
                mcp_server_url: server.server_url
              }))
            : server.tools.filter((tool) => !removeTools.has(tool.name))
        };
        return Response.json(server);
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    });

    const result = await syncAgentTargetsBuiltInTools('workspace-1', 'agent-cluster-triage');

    assert.equal(result.ok, true);
    assert.equal(result.registeredToolCount, 3);
    const create = requests.find((request) => request.method === 'POST');
    assert.ok(create);
    assert.equal(create.body?.scope_type, 'agent');
    assert.equal(create.body?.agent_id, 'agent-cluster-triage');
    assert.equal(create.body?.server_name, 'acornops-targets');
    assert.equal(create.body?.configuration_attested, undefined);
    assert.deepEqual(
      (create.body?.tools as Array<{ name: string }>).map((tool) => tool.name),
      ['list_targets', 'get_target', 'list_target_issues']
    );
    const synced = await getAgentDefinition('workspace-1', 'agent-cluster-triage');
    assert.equal(synced?.version, before.version + 1);
    assert.deepEqual(synced?.mcpServers, [server.id]);
    assert.deepEqual(
      synced?.mcpInstallations[0]?.tools.map((tool) => tool.toolName),
      ['list_targets', 'get_target', 'list_target_issues']
    );
    const mappingsAfter = (await listCapabilityRoutingMappings('workspace-1', { activeReviewedOnly: true }))
      .filter((mapping) => mapping.agentId === before.id);
    assert.ok(mappingsAfter.length > mappingsBefore.length);
    assert.ok(mappingsBefore.every((mapping) => (
      mappingsAfter.some((candidate) => candidate.id === mapping.id && candidate.agentVersion === synced?.version)
    )));
    assert.equal(
      mappingsAfter.find((mapping) => mapping.id === staleMapping.id)?.agentVersion,
      staleMapping.agentVersion
    );
    assert.equal(synced?.readiness.status, 'ready');

    const patchCountBeforeNoOp = requests.filter((request) => request.method === 'PATCH').length;
    const noOp = await syncAgentTargetsBuiltInTools('workspace-1', 'agent-cluster-triage');
    assert.equal(noOp.ok, true);
    assert.equal(noOp.agent?.version, synced?.version);
    assert.equal(
      requests.filter((request) => request.method === 'PATCH').length,
      patchCountBeforeNoOp
    );

    const drifted = await updateAgentDefinition('workspace-1', 'agent-cluster-triage', {
      mcpInstallations: synced!.mcpInstallations.map((installation) => ({
        ...installation,
        name: 'stale-targets-name',
        targetConstraints: { targetTypes: [], targetIds: ['stale-target'] }
      }))
    });
    assert.ok(drifted);
    const driftRepair = await syncAgentTargetsBuiltInTools('workspace-1', 'agent-cluster-triage');
    assert.equal(driftRepair.ok, true);
    assert.equal(driftRepair.agent?.version, drifted.version + 1);
    assert.equal(driftRepair.agent?.mcpInstallations[0]?.name, 'acornops-targets');
    assert.deepEqual(
      driftRepair.agent?.mcpInstallations[0]?.targetConstraints,
      { targetTypes: ['kubernetes', 'virtual_machine'], targetIds: [] }
    );
    assert.equal(
      requests.filter((request) => request.method === 'PATCH').length,
      patchCountBeforeNoOp
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
    const repairRequest = requests.find((request) => request.method === 'PATCH');
    assert.deepEqual(repairRequest?.body?.remove_tools, ['rogue_tool']);

    Object.assign(server, {
      auth_type: 'bearer_token',
      credential_mode: 'workspace',
      auth_header_name: 'Authorization',
      auth_header_prefix: 'Bearer ',
      public_headers: { 'x-unexpected': 'drift' }
    });
    const authRepair = await syncAgentTargetsBuiltInTools('workspace-1', 'agent-cluster-triage');
    assert.equal(authRepair.ok, true);
    const authRepairRequest = requests.filter((request) => request.method === 'PATCH').at(-1);
    assert.equal(authRepairRequest?.body?.auth_type, 'none');
    assert.equal(authRepairRequest?.body?.credential_mode, 'none');
    assert.deepEqual(authRepairRequest?.body?.public_headers, {});
    assert.equal(server.auth_type, 'none');
    assert.equal(server.credential_mode, 'none');
    assert.equal(server.auth_header_name, null);
    assert.equal(server.auth_header_prefix, null);
    assert.deepEqual(server.public_headers, {});
  });
});
