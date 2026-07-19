import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capabilitiesToPermissions } from '../../src/auth/authorization.js';
import { compileAgentRunScope } from '../../src/services/agent-access.js';
import type { AgentDefinition } from '../../src/types/agents.js';
import type { CapabilityRoutingMapping } from '../../src/types/capability-routing.js';

function createAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-1', workspaceId: 'workspace-1', name: 'Incident analyst',
    description: 'Collects target signals and drafts incident summaries.',
    instructions: 'Use only the exact resources compiled for this run.',
    status: 'active', origin: { type: 'manual' }, kind: 'specialist', reviewState: 'reviewed',
    providerType: 'internal', version: 3, ownerUserId: 'owner-1', createdBy: 'owner-1',
    createdAt: '2026-06-27T00:00:00.000Z', updatedAt: '2026-06-27T00:00:00.000Z',
    mcpServers: [], mcpTools: [], mcpInstallations: [], tools: [], skills: [], skillInstallations: [],
    contextGrants: [], targetScope: { type: 'workspace', targetTypes: ['kubernetes'] },
    approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'ask_before_changes', semanticCapabilityIds: ['incident.observe'],
    delegateAgentIds: [], triggers: [], activity: { runCount: 0 }, readiness: { status: 'ready', reasons: [] },
    ...overrides
  };
}

function mapping(agent: AgentDefinition): CapabilityRoutingMapping {
  return {
    id: 'mapping-1', workspaceId: agent.workspaceId, capabilityId: 'incident.observe', version: 1,
    agentId: agent.id, agentVersion: agent.version, status: 'active', reviewState: 'reviewed', priority: 10,
    targetTypes: ['kubernetes'], targetIds: [],
    mcpTools: [{ serverId: 'server-1', toolName: 'events.search', alias: 'mcp_server_1_events_search', operation: 'read' }],
    targetToolRefs: [],
    nativeToolIds: ['inventory.resources.list', 'logs.summarize'], skillIds: ['acornops-observability'],
    contextGrants: ['target_inventory', 'workspace_metadata'], createdBy: 'owner-1', reviewedBy: 'owner-1',
    createdAt: '2026-06-27T00:00:00.000Z', updatedAt: '2026-06-27T00:00:00.000Z'
  };
}

describe('agent access compiler', () => {
  it('compiles only exact live resources from the reviewed semantic mapping', () => {
    const agent = createAgent();
    const compiled = compileAgentRunScope({
      agent,
      actor: {
        userId: 'user-operator', role: 'operator',
        permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs'])
      },
      approvedContextGrants: ['workspace_metadata', 'target_inventory'],
      triggerId: 'trigger-manual', mappings: [mapping(agent)]
    });

    assert.deepEqual(compiled.mcpServers, ['server-1']);
    assert.deepEqual(compiled.mcpTools, [{ serverId: 'server-1', toolName: 'events.search' }]);
    assert.deepEqual(compiled.tools, ['inventory.resources.list', 'logs.summarize', 'mcp_server_1_events_search']);
    assert.deepEqual(compiled.enabledSkills, ['acornops-observability']);
    assert.deepEqual(compiled.contextGrants, ['target_inventory', 'workspace_metadata']);
    assert.deepEqual(compiled.semanticCapabilityIds, ['incident.observe']);
    assert.deepEqual(compiled.coordinationFunctions, []);
    assert.deepEqual(compiled.jwtClaims.permissions.allowed_tool_refs, [
      { server_id: 'server-1', tool_name: 'events.search' }
    ]);
    assert.deepEqual(compiled.principal, { type: 'user', id: 'user-operator' });
  });

  it('compiles reviewed exact attachments for a user-created Agent without platform capabilities', () => {
    const agent = createAgent({
      semanticCapabilityIds: [],
      mcpInstallations: [{
        id: 'user-server',
        name: 'User-selected MCP server',
        url: 'https://mcp.example.com/v1/',
        enabled: true,
        authScope: 'personal',
        revision: 1,
        targetConstraints: { targetTypes: [], targetIds: [] },
        tools: [{
          serverId: 'user-server',
          toolName: 'inspect_repository',
          alias: 'inspect_repository',
          capability: 'read',
          enabled: true,
          reviewState: 'approved',
          riskLevel: 'read_only',
          autoAllowed: false
        }]
      }],
      skillInstallations: [{
        id: 'user-review-guidance',
        name: 'User review guidance',
        description: 'Workspace-authored review instructions.',
        enabled: true,
        revision: 1,
        contentDigest: 'sha256:user-review-guidance',
        source: { type: 'manual' },
        files: []
      }],
      contextGrants: ['workspace_metadata']
    });
    const compiled = compileAgentRunScope({
      agent,
      actor: {
        userId: 'user-operator', role: 'operator',
        permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs'])
      },
      approvedContextGrants: ['workspace_metadata']
    });

    assert.deepEqual(compiled.semanticCapabilityIds, []);
    assert.deepEqual(compiled.mcpTools, [{ serverId: 'user-server', toolName: 'inspect_repository' }]);
    assert.deepEqual(compiled.tools, ['inspect_repository']);
    assert.deepEqual(compiled.enabledSkills, ['user-review-guidance']);
    assert.deepEqual(compiled.contextGrants, ['workspace_metadata']);
  });

  it('exposes coordination functions and no operational tools to the system workflow coordinator', () => {
    const coordinator = createAgent({
      id: 'workflow-coordinator-1', kind: 'manager', systemRole: 'workflow_coordinator',
      semanticCapabilityIds: ['incident.observe'],
      delegateAgentIds: ['agent-1']
    });
    const compiled = compileAgentRunScope({
      agent: coordinator,
      actor: {
        userId: 'user-operator', role: 'operator',
        permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs'])
      },
      approvedContextGrants: []
    });
    assert.deepEqual(compiled.tools, []);
    assert.deepEqual(compiled.mcpTools, []);
    assert.deepEqual(compiled.coordinationFunctions, [
      '_acornops_delegate_specialist', '_acornops_await_delegations'
    ]);
  });

  it('requires one exact in-scope target for target diagnostics', () => {
    const agent = createAgent({
      semanticCapabilityIds: ['target.diagnostics.read'],
      targetScope: { type: 'selected_target', targetTypes: ['kubernetes'], targetIds: ['target-allowed'] }
    });
    const route = {
      ...mapping(agent),
      capabilityId: 'target.diagnostics.read',
      targetIds: ['target-allowed'],
      mcpTools: [],
      nativeToolIds: [],
      skillIds: [],
      contextGrants: [],
      targetToolRefs: [{ serverId: 'builtin-target', toolName: 'get_resource', alias: 'get_resource', operation: 'read' as const }]
    };
    const input = {
      agent,
      actor: { userId: 'user-operator', role: 'operator', permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs']) },
      approvedContextGrants: [],
      mappings: [route]
    };
    assert.throws(() => compileAgentRunScope(input), (error: unknown) => (
      error instanceof Error && 'code' in error && error.code === 'AGENT_TARGET_REQUIRED'
    ));
    assert.throws(() => compileAgentRunScope({ ...input, exactTarget: { id: 'target-denied', targetType: 'kubernetes' } }), (error: unknown) => (
      error instanceof Error && 'code' in error && error.code === 'AGENT_TARGET_SCOPE_DENIED'
    ));
    const compiled = compileAgentRunScope({ ...input, exactTarget: { id: 'target-allowed', targetType: 'kubernetes' } });
    assert.deepEqual(compiled.tools, ['get_resource']);
    assert.deepEqual(compiled.mcpTools, []);
    assert.deepEqual(compiled.targetToolRefs, [{ serverId: 'builtin-target', toolName: 'get_resource' }]);
    assert.deepEqual(compiled.exactTargets, [{ id: 'target-allowed', targetType: 'kubernetes' }]);
  });

  it('compiles approval-gated write tools only for a remediation Agent with read-write permission', () => {
    const agent = createAgent({
      semanticCapabilityIds: ['target.diagnostics.read', 'target.remediation.write'],
      targetScope: { type: 'selected_target', targetTypes: ['kubernetes'], targetIds: ['target-allowed'] }
    });
    const readRoute = {
      ...mapping(agent),
      capabilityId: 'target.diagnostics.read',
      targetIds: ['target-allowed'],
      mcpTools: [], nativeToolIds: [], skillIds: [], contextGrants: [],
      targetToolRefs: [{ serverId: 'builtin-target', toolName: 'get_resource', alias: 'get_resource', operation: 'read' as const }]
    };
    const writeRoute = {
      ...mapping(agent),
      id: 'mapping-remediation',
      capabilityId: 'target.remediation.write',
      targetIds: ['target-allowed'],
      mcpTools: [], nativeToolIds: [], skillIds: [], contextGrants: [],
      targetToolRefs: [{ serverId: 'builtin-target', toolName: 'restart_workload', alias: 'restart_workload', operation: 'write' as const }]
    };
    const compiled = compileAgentRunScope({
      agent,
      actor: {
        userId: 'user-admin', role: 'admin',
        permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_write_runs'])
      },
      approvedContextGrants: [],
      mappings: [readRoute, writeRoute],
      exactTarget: { id: 'target-allowed', targetType: 'kubernetes' }
    });

    assert.deepEqual(compiled.tools, ['get_resource', 'restart_workload']);
    assert.equal(compiled.toolOperations.get_resource, 'read');
    assert.equal(compiled.toolOperations.restart_workload, 'write');
    assert.equal(compiled.permissionMode, 'ask_before_changes');
    assert.deepEqual(compiled.approvalGates, ['Before every write-capable tool']);
  });
});
