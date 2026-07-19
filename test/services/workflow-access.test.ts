import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capabilitiesToPermissions } from '../../src/auth/authorization.js';
import {
  compileWorkflowAccessScope,
  compileWorkflowSessionCeiling,
  workflowToolOperation,
  WorkflowAccessDeniedError,
  type WorkflowDefinitionForAccess
} from '../../src/services/workflow-access.js';
import type { AgentDefinition } from '../../src/types/agents.js';
import type { CapabilityRoutingMapping } from '../../src/types/capability-routing.js';

function createWorkflow(overrides: Partial<WorkflowDefinitionForAccess> = {}): WorkflowDefinitionForAccess {
  return {
    id: 'workflow-1',
    workspaceId: 'workspace-1',
    version: 7,
    origin: { type: 'manual' },
    name: 'Audit workspace MCP exposure',
    prompt: 'Inspect the reviewed workspace capability mapping.',
    agentIds: ['agent-incident'],
    executionMode: 'direct',
    entryAgentId: 'agent-incident',
    requiredPermissions: ['read_workspace_data'],
    capabilityPolicy: {
      mode: 'read_only',
      semanticCapabilityIds: ['workspace.audit.read'],
      contextGrants: ['audit_events', 'workspace_metadata'],
      maxRuntimeSeconds: 600,
      retentionDays: 90,
      approvalRequirements: []
    },
    createdBy: 'owner-1',
    ...overrides
  };
}

function createAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-incident',
    workspaceId: 'workspace-1',
    name: 'Incident analyst',
    description: 'Reads workspace signals.',
    instructions: 'Stay inside the compiled scope.',
    status: 'active',
    origin: { type: 'manual' },
    kind: 'specialist',
    reviewState: 'reviewed',
    providerType: 'internal',
    version: 2,
    ownerUserId: 'owner-1',
    createdBy: 'owner-1',
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    mcpServers: ['audit-log'],
    mcpTools: [],
    mcpInstallations: [],
    tools: ['mcp.servers.list', 'roles.permissions.read'],
    skills: ['acornops-security-baseline'],
    skillInstallations: [],
    contextGrants: ['audit_events', 'workspace_metadata'],
    targetScope: { type: 'workspace' },
    approvalPolicy: { mode: 'none', writeToolsRequireApproval: false },
    trustPolicy: { level: 'restricted', allowExternalData: false },
    permissionMode: 'read_only',
    semanticCapabilityIds: ['workspace.audit.read'],
    delegateAgentIds: [],
    triggers: [],
    activity: { runCount: 0 },
    readiness: { status: 'ready', reasons: [] },
    ...overrides
  };
}

function createMapping(overrides: Partial<CapabilityRoutingMapping> = {}): CapabilityRoutingMapping {
  return {
    id: 'route-workspace-audit',
    workspaceId: 'workspace-1',
    capabilityId: 'workspace.audit.read',
    version: 1,
    agentId: 'agent-incident',
    agentVersion: 2,
    status: 'active',
    reviewState: 'reviewed',
    priority: 10,
    targetTypes: [],
    targetIds: [],
    mcpTools: [
      { serverId: 'audit-log', toolName: 'events-search', alias: 'audit.events.search', operation: 'read' }
    ],
    targetToolRefs: [],
    nativeToolIds: ['mcp.servers.list', 'roles.permissions.read'],
    invocationScopes: ['agent', 'workflow'],
    skillIds: ['acornops-security-baseline'],
    contextGrants: ['audit_events'],
    createdBy: 'owner-1',
    reviewedBy: 'owner-1',
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    ...overrides
  };
}

function compile(overrides: {
  workflow?: WorkflowDefinitionForAccess;
  entryAgent?: AgentDefinition;
  mappings?: CapabilityRoutingMapping[];
  approvedContextGrants?: string[];
  permissions?: string[];
} = {}) {
  return compileWorkflowAccessScope({
    workflow: overrides.workflow || createWorkflow(),
    entryAgent: overrides.entryAgent || createAgent(),
    mappings: overrides.mappings || [createMapping()],
    actor: {
      userId: 'user-operator',
      role: 'operator',
      permissions: capabilitiesToPermissions(overrides.permissions || [
        'read_workspace_data',
        'create_sessions',
        'create_read_only_runs'
      ])
    },
    approvedContextGrants: overrides.approvedContextGrants || ['workspace_metadata', 'audit_events']
  });
}

describe('workflow access compiler', () => {
  it('keeps canonical reads read-only and conservatively gates writes and unknown tools', () => {
    assert.equal(workflowToolOperation('repository.file.read', 'read_write'), 'read');
    assert.equal(workflowToolOperation('repository.tree.list', 'read_write'), 'read');
    assert.equal(workflowToolOperation('repository.commit.create', 'read_write'), 'write');
    assert.equal(workflowToolOperation('vendor.custom.operation', 'read_write'), 'write');
    assert.equal(workflowToolOperation('repository.commit.create', 'read_only'), 'read');
  });

  it('compiles exact reviewed resources from the specialist Agent mapping', () => {
    const compiled = compile();

    assert.deepEqual(compiled.semanticCapabilityIds, ['workspace.audit.read']);
    assert.deepEqual(compiled.mcpServers, ['audit-log']);
    assert.deepEqual(compiled.mcpTools, [{ serverId: 'audit-log', toolName: 'events-search' }]);
    assert.deepEqual(compiled.tools, ['audit.events.search', 'mcp.servers.list', 'roles.permissions.read']);
    assert.deepEqual(compiled.enabledSkills, ['acornops-security-baseline']);
    assert.deepEqual(compiled.contextGrants, ['audit_events', 'workspace_metadata']);
    assert.deepEqual(compiled.entryAgent, { id: 'agent-incident', version: 2, kind: 'specialist' });
    assert.equal(compiled.jwtClaims.agent_id, 'agent-incident');
    assert.equal(compiled.jwtClaims.agent_version, 2);
  });

  it('lets a user-created workflow inherit reviewed exact attachments from a user-created Agent', () => {
    const workflow = createWorkflow({
      capabilityPolicy: {
        ...createWorkflow().capabilityPolicy,
        restrictionMode: 'inherit',
        semanticCapabilityIds: [],
        contextGrants: []
      }
    });
    const agent = createAgent({
      semanticCapabilityIds: [],
      tools: [],
      contextGrants: [],
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
          toolName: 'inspect_resource',
          alias: 'inspect_resource',
          capability: 'read',
          enabled: true,
          reviewState: 'approved',
          riskLevel: 'read_only',
          autoAllowed: false
        }]
      }]
    });
    const compiled = compileWorkflowAccessScope({
      workflow,
      entryAgent: agent,
      selectedAgents: [agent],
      mappings: [],
      actor: {
        userId: 'user-operator',
        role: 'operator',
        permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs'])
      },
      approvedContextGrants: []
    });

    assert.deepEqual(compiled.semanticCapabilityIds, []);
    assert.deepEqual(compiled.mcpTools, [{ serverId: 'user-server', toolName: 'inspect_resource' }]);
    assert.deepEqual(compiled.tools, ['inspect_resource']);
    assert.equal(compiled.toolOperations.inspect_resource, 'read');
  });

  it('rejects read-write workflows when the actor lacks read-write run capability', () => {
    const workflow = createWorkflow({
      capabilityPolicy: { ...createWorkflow().capabilityPolicy, mode: 'read_write' }
    });
    assert.throws(
      () => compile({ workflow }),
      (error) => error instanceof WorkflowAccessDeniedError
        && error.code === 'WORKFLOW_PERMISSION_DENIED'
        && error.missingPermissions.includes('create_read_write_runs')
    );
  });

  it('rejects workflow context grants that were not explicitly approved', () => {
    assert.throws(
      () => compile({ approvedContextGrants: ['workspace_metadata'] }),
      (error) => error instanceof WorkflowAccessDeniedError
        && error.code === 'WORKFLOW_CONTEXT_GRANT_DENIED'
        && error.missingContextGrants.includes('audit_events')
    );
  });

  it('allows a workflow to subtract every operational capability from its Agent ceiling', () => {
    const base = createWorkflow();
    const compiled = compile({
      workflow: createWorkflow({
        capabilityPolicy: {
          ...base.capabilityPolicy,
          semanticCapabilityIds: [],
          contextGrants: []
        }
      }),
      mappings: [],
      approvedContextGrants: []
    });

    assert.deepEqual(compiled.mcpServers, []);
    assert.deepEqual(compiled.tools, []);
    assert.deepEqual(compiled.enabledSkills, []);
    assert.deepEqual(compiled.contextGrants, []);
  });

  it('inherits the selected Agents current ceiling and snapshots the resolved set', () => {
    const base = createWorkflow();
    const workflow = createWorkflow({ capabilityPolicy: {
      ...base.capabilityPolicy, restrictionMode: 'inherit', semanticCapabilityIds: []
    } });
    const agent = createAgent({ semanticCapabilityIds: ['workspace.audit.read'] });
    const compiled = compileWorkflowAccessScope({
      workflow, entryAgent: agent, selectedAgents: [agent], mappings: [createMapping()],
      actor: { userId: 'user-operator', role: 'operator', permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs']) },
      approvedContextGrants: ['workspace_metadata', 'audit_events']
    });
    assert.equal(compiled.capabilityRestrictionMode, 'inherit');
    assert.deepEqual(compiled.semanticCapabilityIds, ['workspace.audit.read']);
  });

  it('keeps PDF artifact creation in read-only workflows without write approval', () => {
    const base = createWorkflow();
    const workflow = createWorkflow({ capabilityPolicy: {
      ...base.capabilityPolicy, restrictionMode: 'restrict', semanticCapabilityIds: ['reports.pdf.generate'], contextGrants: []
    } });
    const agent = createAgent({ semanticCapabilityIds: ['reports.pdf.generate'], tools: ['reports.pdf.generate'] });
    const mapping = createMapping({
      capabilityId: 'reports.pdf.generate', mcpTools: [], nativeToolIds: ['reports.pdf.generate'],
      skillIds: [], contextGrants: [], invocationScopes: ['workflow']
    });
    const compiled = compileWorkflowAccessScope({
      workflow, entryAgent: agent, selectedAgents: [agent], mappings: [mapping],
      actor: { userId: 'user-operator', role: 'operator', permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs']) },
      approvedContextGrants: []
    });
    assert.deepEqual(compiled.tools, ['reports.pdf.generate']);
    assert.equal(compiled.toolOperations['reports.pdf.generate'], 'read');
    assert.equal(compiled.permissionMode, 'read_only');
  });

  it('rejects workflow-only native mappings from direct Agent compilation scope', async () => {
    const { compileAgentRunScope, AgentAccessDeniedError } = await import('../../src/services/agent-access.js');
    const agent = createAgent({ semanticCapabilityIds: ['reports.pdf.generate'], tools: ['reports.pdf.generate'] });
    assert.throws(() => compileAgentRunScope({
      agent,
      actor: { userId: 'user-operator', role: 'operator', permissions: capabilitiesToPermissions(['create_read_only_runs']) },
      approvedContextGrants: [],
      mappings: [createMapping({ capabilityId: 'reports.pdf.generate', mcpTools: [], nativeToolIds: ['reports.pdf.generate'], invocationScopes: ['workflow'] })]
    }), (error) => error instanceof AgentAccessDeniedError && error.code === 'AGENT_CAPABILITY_MAPPING_UNAVAILABLE');
  });

  it('fails closed when a requested semantic capability has no exact reviewed mapping', () => {
    assert.throws(
      () => compile({ mappings: [] }),
      (error) => error instanceof WorkflowAccessDeniedError
        && error.code === 'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE'
    );
  });

  it('rejects an unavailable internal workflow routing Agent', () => {
    assert.throws(
      () => compile({ entryAgent: createAgent({ status: 'disabled' }) }),
      (error) => error instanceof WorkflowAccessDeniedError
        && error.code === 'WORKFLOW_AGENT_SCOPE_DENIED'
    );
  });

  it('rejects mappings outside an exact target binding', () => {
    assert.throws(
      () => compileWorkflowAccessScope({
        workflow: createWorkflow(),
        entryAgent: createAgent(),
        mappings: [createMapping({ targetIds: ['target-allowed'] })],
        actor: {
          userId: 'user-operator',
          role: 'operator',
          permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs'])
        },
        approvedContextGrants: ['workspace_metadata', 'audit_events'],
        exactTargets: [{ id: 'target-denied', targetType: 'kubernetes' }]
      }),
      (error) => error instanceof WorkflowAccessDeniedError
        && error.code === 'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE'
    );
  });

  it('keeps target-specific resources out of the reusable session ceiling', () => {
    const base = createWorkflow();
    const workflow = createWorkflow({ capabilityPolicy: {
      ...base.capabilityPolicy,
      semanticCapabilityIds: ['target.diagnostics.read'],
      contextGrants: []
    } });
    const agent = createAgent({ semanticCapabilityIds: ['target.diagnostics.read'] });
    const ceiling = compileWorkflowSessionCeiling({
      workflow,
      entryAgent: agent,
      actor: { userId: 'user-operator', role: 'operator', permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs']) },
      approvedContextGrants: []
    });
    assert.equal(ceiling.resourceResolutionPhase, 'session_ceiling');
    assert.deepEqual(ceiling.tools, []);
    assert.deepEqual(ceiling.exactTargets, []);
  });

  it('intersects workflow, Agent, mapping, and exact target scope for diagnostics', () => {
    const base = createWorkflow();
    const workflow = createWorkflow({
      targetConstraints: { targetTypes: ['kubernetes'], targetIds: ['target-1'] },
      capabilityPolicy: { ...base.capabilityPolicy, semanticCapabilityIds: ['target.diagnostics.read'], contextGrants: [] }
    });
    const agent = createAgent({
      semanticCapabilityIds: ['target.diagnostics.read'],
      targetScope: { type: 'selected_target', targetTypes: ['kubernetes'], targetIds: ['target-1'] }
    });
    const route = createMapping({
      capabilityId: 'target.diagnostics.read', targetTypes: ['kubernetes'], targetIds: ['target-1'],
      mcpTools: [], nativeToolIds: [], skillIds: [], contextGrants: [],
      targetToolRefs: [{ serverId: 'builtin-target', toolName: 'list_resources', alias: 'list_resources', operation: 'read' }]
    });
    const compiled = compileWorkflowAccessScope({
      workflow, entryAgent: agent, mappings: [route], exactTargets: [{ id: 'target-1', targetType: 'kubernetes' }],
      actor: { userId: 'user-operator', role: 'operator', permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs']) },
      approvedContextGrants: []
    });
    assert.deepEqual(compiled.tools, ['list_resources']);
    assert.deepEqual(compiled.targetToolRefs, [{ serverId: 'builtin-target', toolName: 'list_resources' }]);
    assert.equal(compiled.resourceResolutionPhase, 'run_exact');
  });

  it('keeps target write references out of read-only workflow scopes', () => {
    const base = createWorkflow();
    const workflow = createWorkflow({
      targetConstraints: { targetTypes: ['kubernetes'], targetIds: ['target-1'] },
      capabilityPolicy: { ...base.capabilityPolicy, semanticCapabilityIds: ['target.diagnostics.read'], contextGrants: [] }
    });
    const agent = createAgent({
      semanticCapabilityIds: ['target.diagnostics.read'],
      targetScope: { type: 'selected_target', targetTypes: ['kubernetes'], targetIds: ['target-1'] }
    });
    const route = createMapping({
      capabilityId: 'target.diagnostics.read', targetTypes: ['kubernetes'], targetIds: ['target-1'],
      mcpTools: [], nativeToolIds: [], skillIds: [], contextGrants: [],
      targetToolRefs: [
        { serverId: 'builtin-target', toolName: 'list_resources', alias: 'list_resources', operation: 'read' },
        { serverId: 'builtin-target', toolName: 'restart_workload', alias: 'restart_workload', operation: 'write' }
      ]
    });
    const compiled = compileWorkflowAccessScope({
      workflow, entryAgent: agent, mappings: [route], exactTargets: [{ id: 'target-1', targetType: 'kubernetes' }],
      actor: { userId: 'user-operator', role: 'operator', permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_only_runs']) },
      approvedContextGrants: []
    });
    assert.deepEqual(compiled.tools, ['list_resources']);
    assert.deepEqual(compiled.targetToolRefs, [{ serverId: 'builtin-target', toolName: 'list_resources' }]);
    assert.equal(compiled.permissionMode, 'read_only');
  });

  it('compiles exact read and write target mappings for approval-gated remediation', () => {
    const base = createWorkflow();
    const workflow = createWorkflow({
      targetConstraints: { targetTypes: ['kubernetes'], targetIds: ['target-1'] },
      capabilityPolicy: {
        ...base.capabilityPolicy,
        mode: 'read_write',
        semanticCapabilityIds: ['target.diagnostics.read', 'target.remediation.write'],
        contextGrants: [],
        approvalRequirements: ['Before every write-capable target tool']
      }
    });
    const agent = createAgent({
      semanticCapabilityIds: ['target.diagnostics.read', 'target.remediation.write'],
      targetScope: { type: 'selected_target', targetTypes: ['kubernetes'], targetIds: ['target-1'] },
      permissionMode: 'ask_before_changes',
      approvalPolicy: { mode: 'before_write', writeToolsRequireApproval: true }
    });
    const readRoute = createMapping({
      capabilityId: 'target.diagnostics.read', targetTypes: ['kubernetes'], targetIds: ['target-1'],
      mcpTools: [], nativeToolIds: [], skillIds: [], contextGrants: [],
      targetToolRefs: [{ serverId: 'builtin-target', toolName: 'list_resources', alias: 'list_resources', operation: 'read' }]
    });
    const writeRoute = createMapping({
      id: 'route-target-remediation', capabilityId: 'target.remediation.write',
      targetTypes: ['kubernetes'], targetIds: ['target-1'], mcpTools: [], nativeToolIds: [], skillIds: [], contextGrants: [],
      targetToolRefs: [{ serverId: 'builtin-target', toolName: 'restart_workload', alias: 'restart_workload', operation: 'write' }]
    });
    const compiled = compileWorkflowAccessScope({
      workflow, entryAgent: agent, mappings: [readRoute, writeRoute],
      exactTargets: [{ id: 'target-1', targetType: 'kubernetes' }],
      actor: { userId: 'user-operator', role: 'admin', permissions: capabilitiesToPermissions(['read_workspace_data', 'create_read_write_runs']) },
      approvedContextGrants: []
    });
    assert.deepEqual(compiled.semanticCapabilityIds, ['target.diagnostics.read', 'target.remediation.write']);
    assert.deepEqual(compiled.tools, ['list_resources', 'restart_workload']);
    assert.equal(compiled.toolOperations.list_resources, 'read');
    assert.equal(compiled.toolOperations.restart_workload, 'write');
    assert.equal(compiled.permissionMode, 'ask_before_changes');
    assert.deepEqual(compiled.approvalGates, ['Before every write-capable target tool']);
  });
});
