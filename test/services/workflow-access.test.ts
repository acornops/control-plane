import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capabilitiesToPermissions } from '../../src/auth/authorization.js';
import {
  compileWorkflowAccessScope,
  compileWorkflowSessionCeiling,
  selectDelegationCandidate,
  WorkflowAccessDeniedError
} from '../../src/services/workflow-access.js';
import { COORDINATOR_FUNCTIONS } from '../../src/services/coordination-functions.js';
import type { AgentDefinition } from '../../src/types/agents.js';
import type { CapabilityRoutingMapping } from '../../src/types/capability-routing.js';
import type { WorkflowDefinitionForAccess } from '../../src/types/workflows.js';

function agent(id: string, version = 2): AgentDefinition {
  return {
    id,
    workspaceId: 'workspace-1',
    name: id,
    instructions: 'Use only the compiled scope.',
    status: 'active',
    origin: { type: 'manual' },
    reviewState: 'reviewed',
    providerType: 'internal',
    version,
    ownerUserId: 'owner-1',
    createdBy: 'owner-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    mcpServers: ['ops'],
    mcpTools: [],
    mcpInstallations: [],
    tools: ['workspace.metadata.read'],
    skills: [],
    skillInstallations: [],
    contextGrants: ['workspace_metadata'],
    targetScope: { type: 'workspace' },
    approvalPolicy: { mode: 'none', writeToolsRequireApproval: false },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'read_only',
    semanticCapabilityIds: ['workspace.audit.read'],
    workflowUsage: { workflowRunCount: 0 },
    readiness: { status: 'ready', reasons: [] }
  };
}

function workflow(agents: AgentDefinition[]): WorkflowDefinitionForAccess {
  return {
    id: 'workflow-1',
    workspaceId: 'workspace-1',
    version: 4,
    origin: { type: 'manual' },
    name: 'Audit',
    prompt: 'Audit the workspace.',
    agentIds: agents.map((value) => value.id),
    executionMode: agents.length > 1 ? 'coordinated' : 'direct',
    resourceRequirements: [],
    capabilityPolicy: {
      mode: 'read_only',
      restrictionMode: 'restrict',
      semanticCapabilityIds: ['workspace.audit.read'],
      contextGrants: ['workspace_metadata'],
      maxRuntimeSeconds: 300,
      retentionDays: 30,
      approvalRequirements: []
    },
    requiredPermissions: ['read_workspace_data'],
    createdBy: 'owner-1'
  };
}

function mapping(specialist: AgentDefinition, priority = 10): CapabilityRoutingMapping {
  return {
    id: `mapping-${specialist.id}`,
    workspaceId: specialist.workspaceId,
    capabilityId: 'workspace.audit.read',
    version: 1,
    agentId: specialist.id,
    agentVersion: specialist.version,
    status: 'active',
    reviewState: 'reviewed',
    priority,
    targetTypes: [],
    targetIds: [],
    mcpTools: [{
      serverId: 'ops',
      toolName: 'events_search',
      alias: 'events.search',
      operation: 'read'
    }],
    targetToolRefs: [],
    nativeToolIds: ['workspace.metadata.read'],
    skillIds: [],
    contextGrants: ['workspace_metadata'],
    createdBy: 'owner-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z'
  };
}

const actor = {
  userId: 'operator-1',
  role: 'operator',
  permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs'])
};

describe('Workflow executor scope compiler', () => {
  it('creates a direct specialist root with pinned Agent identity and exact capabilities', () => {
    const specialist = agent('agent-a');
    const compiled = compileWorkflowAccessScope({
      workflow: workflow([specialist]),
      selectedAgents: [specialist],
      specialistAgent: specialist,
      mappings: [mapping(specialist)],
      actor,
      approvedContextGrants: ['workspace_metadata']
    });

    assert.deepEqual(compiled.executor, { role: 'specialist', agentId: 'agent-a', agentVersion: 2 });
    assert.equal(compiled.jwtClaims.executor_role, 'specialist');
    assert.equal(compiled.jwtClaims.agent_id, 'agent-a');
    assert.deepEqual(compiled.tools, ['events.search', 'workspace.metadata.read']);
    assert.deepEqual(compiled.coordinationFunctions, []);
  });

  it('creates a coordinated root with only internal coordination functions and no Agent identity', () => {
    const agents = [agent('agent-a'), agent('agent-b')];
    const compiled = compileWorkflowAccessScope({
      workflow: workflow(agents),
      selectedAgents: agents,
      mappings: agents.map((value) => mapping(value)),
      actor,
      approvedContextGrants: ['workspace_metadata']
    });

    assert.equal(compiled.executor.role, 'coordinator');
    assert.equal(compiled.jwtClaims.executor_role, 'coordinator');
    assert.equal(compiled.jwtClaims.agent_id, undefined);
    assert.deepEqual(compiled.tools, []);
    assert.deepEqual(compiled.mcpServers, []);
    assert.deepEqual(compiled.enabledSkills, []);
    assert.deepEqual(compiled.contextGrants, []);
    assert.deepEqual(compiled.resourceBindings, []);
    assert.deepEqual(compiled.selectedAgentSnapshots, []);
    assert.deepEqual(compiled.coordinationFunctions, COORDINATOR_FUNCTIONS);
  });

  it('keeps the session ceiling distinct from a delegated specialist exact scope', () => {
    const agents = [agent('agent-a'), agent('agent-b')];
    const definition = workflow(agents);
    const ceiling = compileWorkflowSessionCeiling({
      workflow: definition,
      selectedAgents: agents,
      mappings: agents.map((value) => mapping(value)),
      actor,
      approvedContextGrants: ['workspace_metadata']
    });
    const child = compileWorkflowAccessScope({
      workflow: definition,
      selectedAgents: agents,
      specialistAgent: agents[1],
      mappings: [mapping(agents[1])],
      actor,
      approvedContextGrants: ['workspace_metadata'],
      delegatedSpecialist: true
    });

    assert.equal(ceiling.executor.role, 'coordinator');
    assert.deepEqual(ceiling.semanticCapabilityIds, ['workspace.audit.read']);
    assert.equal(ceiling.routingMappingSnapshots.length, 2);
    assert.deepEqual(ceiling.selectedAgents, [
      { id: 'agent-a', version: 2 },
      { id: 'agent-b', version: 2 }
    ]);
    assert.deepEqual(child.executor, { role: 'specialist', agentId: 'agent-b', agentVersion: 2 });
    assert.deepEqual(child.selectedAgents, [{ id: 'agent-b', version: 2 }]);
    assert.deepEqual(child.selectedAgentSnapshots.map((agent) => agent.id), ['agent-b']);
    assert.deepEqual(child.routingMappingSnapshots.map((mapping) => mapping.agentId), ['agent-b']);
    assert.deepEqual(child.tools, ['events.search']);
    assert.equal(child.tools.includes('workspace.metadata.read'), false);
  });

  it('rejects inactive selected Agents and unavailable exact capability mappings', () => {
    const inactive = { ...agent('agent-a'), status: 'disabled' as const };
    assert.throws(
      () => compileWorkflowAccessScope({
        workflow: workflow([inactive]),
        selectedAgents: [inactive],
        specialistAgent: inactive,
        mappings: [],
        actor,
        approvedContextGrants: ['workspace_metadata']
      }),
      (error) => error instanceof WorkflowAccessDeniedError && error.code === 'WORKFLOW_AGENT_SCOPE_DENIED'
    );

    const specialist = agent('agent-a');
    assert.throws(
      () => compileWorkflowAccessScope({
        workflow: workflow([specialist]),
        selectedAgents: [specialist],
        specialistAgent: specialist,
        mappings: [],
        actor,
        approvedContextGrants: ['workspace_metadata']
      }),
      (error) => error instanceof WorkflowAccessDeniedError
        && error.code === 'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE'
    );
  });

  it('selects only eligible pinned specialists by priority and then Agent ID', () => {
    const agents = [agent('agent-b'), agent('agent-a'), agent('agent-c')];
    const definition = workflow(agents);
    const candidate = selectDelegationCandidate({
      workflow: definition,
      capabilityId: 'workspace.audit.read',
      target: { id: 'target-1', targetType: 'kubernetes' },
      agents,
      mappings: [
        { ...mapping(agents[0], 5), targetTypes: ['kubernetes'] },
        { ...mapping(agents[1], 5), targetTypes: ['kubernetes'] },
        { ...mapping(agents[2], 1), status: 'disabled', targetTypes: ['kubernetes'] }
      ]
    });

    assert.equal(candidate?.agent.id, 'agent-a');
    assert.equal(candidate?.mapping.priority, 5);
  });
});
