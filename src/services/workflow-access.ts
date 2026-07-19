import type { WorkspaceCapability } from '../auth/authorization.js';
import type { AgentDefinition, RunPrincipalRef } from '../types/agents.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import type { WorkspaceAuditOperation } from '../types/domain.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowAccessActor,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';
import { MANAGER_COORDINATION_FUNCTIONS } from './coordination-functions.js';
import { resolveEffectiveWorkflowCapabilityIds } from './workflow-capability-policy.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';
import {
  capabilityRequiresExactTarget,
  targetAllowedByAgentScope,
  targetAllowedByWorkflowConstraints
} from './target-scope-authorization.js';

export type WorkflowAccessDeniedCode =
  | 'WORKFLOW_PERMISSION_DENIED'
  | 'WORKFLOW_CONTEXT_GRANT_DENIED'
  | 'WORKFLOW_AGENT_SCOPE_DENIED'
  | 'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE'
  | 'WORKFLOW_TARGET_REQUIRED'
  | 'WORKFLOW_TARGET_SCOPE_DENIED';

export class WorkflowAccessDeniedError extends Error {
  readonly code: WorkflowAccessDeniedCode;
  readonly missingPermissions: WorkspaceCapability[];
  readonly missingContextGrants: string[];

  constructor(
    code: WorkflowAccessDeniedCode,
    message: string,
    options: { missingPermissions?: WorkspaceCapability[]; missingContextGrants?: string[] } = {}
  ) {
    super(message);
    this.name = 'WorkflowAccessDeniedError';
    this.code = code;
    this.missingPermissions = options.missingPermissions || [];
    this.missingContextGrants = options.missingContextGrants || [];
  }
}

export interface CompileWorkflowAccessInput {
  workflow: WorkflowDefinitionForAccess;
  entryAgent: AgentDefinition;
  selectedAgents?: AgentDefinition[];
  mappings: CapabilityRoutingMapping[];
  actor: WorkflowAccessActor;
  approvedContextGrants: string[];
  exactTargets?: Array<{ id: string; targetType: 'kubernetes' | 'virtual_machine' }>;
  exactRepository?: import('../types/workflows.js').WorkflowRepositoryScope;
  triggerId?: string;
  principal?: RunPrincipalRef;
}

export type { WorkflowDefinitionForAccess } from '../types/workflows.js';

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function requiredRunCapability(workflow: WorkflowDefinitionForAccess): WorkspaceCapability {
  return workflow.capabilityPolicy.mode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
}

function requiredPermissionsFor(workflow: WorkflowDefinitionForAccess): WorkspaceCapability[] {
  return uniqueSorted([...workflow.requiredPermissions, requiredRunCapability(workflow)]) as WorkspaceCapability[];
}

export function workflowToolOperation(
  tool: string,
  mode: WorkflowDefinitionForAccess['capabilityPolicy']['mode']
): WorkspaceAuditOperation {
  if (mode === 'read_only') return 'read';
  const operation = tool.split('.').at(-1)?.toLowerCase() || '';
  return /^(read|list|get|search|query|summarize|describe|inspect|preview|status)$/.test(operation)
    ? 'read'
    : 'write';
}

function mappingCompatible(
  mapping: CapabilityRoutingMapping,
  targets: Array<{ id: string; targetType: 'kubernetes' | 'virtual_machine' }>
): boolean {
  if (mapping.status !== 'active' || mapping.reviewState !== 'reviewed') return false;
  if (targets.length === 0) return mapping.targetIds.length === 0;
  return targets.every((target) => (
    (!mapping.targetIds.length || mapping.targetIds.includes(target.id))
    && (!mapping.targetTypes.length || mapping.targetTypes.includes(target.targetType))
  ));
}

function exactMappingsForSpecialist(
  input: CompileWorkflowAccessInput,
  capabilityIds: string[]
): CapabilityRoutingMapping[] {
  const exactTargets = input.exactTargets || [];
  return capabilityIds.map((capabilityId) => {
    const mapping = input.mappings.find((candidate) => (
      candidate.capabilityId === capabilityId
      && candidate.agentId === input.entryAgent.id
      && candidate.agentVersion === input.entryAgent.version
      && (candidate.invocationScopes || ['agent', 'workflow']).includes('workflow')
      && mappingCompatible(candidate, exactTargets)
    ));
    if (!mapping) {
      throw new WorkflowAccessDeniedError(
        'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE',
        `No active reviewed exact-resource mapping is available for ${capabilityId}.`
      );
    }
    return mapping;
  });
}

export function compileWorkflowAccessScope(input: CompileWorkflowAccessInput): CompiledWorkflowAccessScope {
  const requiredPermissions = requiredPermissionsFor(input.workflow);
  const missingPermissions = requiredPermissions.filter((permission) => !input.actor.permissions[permission]);
  if (missingPermissions.length) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_PERMISSION_DENIED',
      'Current workspace role cannot run this workflow.',
      { missingPermissions }
    );
  }
  if (
    input.entryAgent.workspaceId !== input.workflow.workspaceId
    || input.entryAgent.id !== input.workflow.entryAgentId
    || input.entryAgent.status !== 'active'
    || input.entryAgent.reviewState !== 'reviewed'
  ) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_AGENT_SCOPE_DENIED',
      'Workflow routing is unavailable because the selected Agents are inactive, unreviewed, incompatible, or outside this workspace.'
    );
  }

  const requestedContext = uniqueSorted(input.workflow.capabilityPolicy.contextGrants);
  const approved = new Set(input.approvedContextGrants);
  const missingContextGrants = requestedContext.filter((grant) => !approved.has(grant));
  if (missingContextGrants.length) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_CONTEXT_GRANT_DENIED',
      'Workflow context grants require explicit server-side approval.',
      { missingContextGrants }
    );
  }

  const manager = input.entryAgent.kind === 'manager';
  const selectedAgents = input.selectedAgents?.length ? input.selectedAgents : manager ? [] : [input.entryAgent];
  const effectiveCapabilityIds = resolveEffectiveWorkflowCapabilityIds(input.workflow.capabilityPolicy, selectedAgents);
  const requiresTarget = effectiveCapabilityIds.some(capabilityRequiresExactTarget);
  if (requiresTarget && (input.exactTargets?.length || 0) !== 1) {
    throw new WorkflowAccessDeniedError('WORKFLOW_TARGET_REQUIRED', 'This workflow capability requires one exact target.');
  }
  const exactTarget = input.exactTargets?.[0];
  if (exactTarget && (
    !targetAllowedByAgentScope(input.entryAgent.targetScope, exactTarget)
    || !targetAllowedByWorkflowConstraints(input.workflow.targetConstraints, exactTarget)
  )) {
    throw new WorkflowAccessDeniedError('WORKFLOW_TARGET_SCOPE_DENIED', 'The selected target is outside the Agent or workflow scope.');
  }
  const mappings = manager ? [] : exactMappingsForSpecialist(input, effectiveCapabilityIds);
  const directAttachmentMode = !manager
    && effectiveCapabilityIds.length === 0
    && input.entryAgent.semanticCapabilityIds.length === 0;
  const directMcpTools = directAttachmentMode
    ? input.entryAgent.mcpInstallations.flatMap((installation) => {
        if (!installation.enabled) return [];
        const constraints = installation.targetConstraints || { targetTypes: [], targetIds: [] };
        if ((input.exactTargets || []).some((target) => (
          (constraints.targetIds.length > 0 && !constraints.targetIds.includes(target.id))
          || (constraints.targetTypes.length > 0 && !constraints.targetTypes.includes(target.targetType))
        ))) return [];
        return installation.tools
          .filter((tool) => tool.enabled && tool.reviewState === 'approved')
          .map((tool) => ({
            serverId: tool.serverId,
            toolName: tool.toolName,
            alias: tool.alias,
            operation: tool.capability
          }));
      })
    : [];
  const mcpTools = [...directMcpTools, ...mappings.flatMap((mapping) => mapping.mcpTools)]
    .filter((ref, index, refs) => refs.findIndex((candidate) => (
      candidate.serverId === ref.serverId && candidate.toolName === ref.toolName
    )) === index);
  const nativeToolIds = uniqueSorted([
    ...(directAttachmentMode ? input.entryAgent.tools : []),
    ...mappings.flatMap((mapping) => mapping.nativeToolIds)
  ]);
  const mode = input.workflow.capabilityPolicy.mode;
  const targetToolRefs = mappings.flatMap((mapping) => mapping.targetToolRefs || [])
    .filter((ref, index, refs) => refs.findIndex((candidate) => (
      candidate.serverId === ref.serverId && candidate.toolName === ref.toolName
    )) === index)
    .filter((ref) => mode === 'read_write' || ref.operation === 'read');
  const tools = uniqueSorted([
    ...mcpTools.map((ref) => ref.alias),
    ...targetToolRefs.map((ref) => ref.alias),
    ...nativeToolIds
  ]);
  const toolOperations = {
    ...Object.fromEntries(mcpTools.map((ref) => [ref.alias, ref.operation])),
    ...Object.fromEntries(targetToolRefs.map((ref) => [ref.alias, ref.operation])),
    ...Object.fromEntries(nativeToolIds.map((tool) => [
      tool,
      getWorkspaceNativeTool(tool)?.approvalOperation
        || workflowToolOperation(tool, input.workflow.capabilityPolicy.mode)
    ]))
  } as Record<string, WorkspaceAuditOperation>;
  const effectiveTools = tools.filter((tool) => mode === 'read_write' || toolOperations[tool] === 'read');
  const effectiveRefs = mcpTools.filter((ref) => mode === 'read_write' || ref.operation === 'read');
  const principal = input.principal || { type: 'user' as const, id: input.actor.userId };
  const coordinationFunctions = manager ? [...MANAGER_COORDINATION_FUNCTIONS] : [];
  const contextGrants = uniqueSorted([
    ...requestedContext,
    ...(directAttachmentMode ? input.entryAgent.contextGrants : []),
    ...mappings.flatMap((mapping) => mapping.contextGrants)
  ]);
  const permissionMode = mode === 'read_only' || input.entryAgent.permissionMode === 'read_only'
    ? 'read_only'
    : input.entryAgent.permissionMode;

  return {
    workflowId: input.workflow.id,
    workspaceId: input.workflow.workspaceId,
    workflowVersion: input.workflow.version,
    actor: { userId: input.actor.userId, role: input.actor.role },
    mode,
    semanticCapabilityIds: effectiveCapabilityIds,
    capabilityRestrictionMode: input.workflow.capabilityPolicy.restrictionMode === 'inherit' ? 'inherit' : 'restrict',
    requiredPermissions,
    grantedCapabilities: requiredPermissions,
    mcpServers: uniqueSorted(effectiveRefs.map((ref) => ref.serverId)),
    mcpTools: effectiveRefs.map((ref) => ({ serverId: ref.serverId, toolName: ref.toolName })),
    targetToolRefs: targetToolRefs.map((ref) => ({ serverId: ref.serverId, toolName: ref.toolName })),
    tools: effectiveTools,
    toolOperations,
    enabledSkills: uniqueSorted([
      ...(directAttachmentMode
        ? input.entryAgent.skillInstallations.filter((skill) => skill.enabled).map((skill) => skill.id)
        : []),
      ...mappings.flatMap((mapping) => mapping.skillIds)
    ]),
    contextGrants,
    approvalGates: uniqueSorted(input.workflow.capabilityPolicy.approvalRequirements),
    permissionMode,
    principal,
    entryAgent: {
      id: input.entryAgent.id,
      version: input.entryAgent.version,
      kind: input.entryAgent.kind
    },
    exactTargets: [...(input.exactTargets || [])],
    ...(input.exactRepository ? { exactRepository: { ...input.exactRepository } } : {}),
    resourceResolutionPhase: 'run_exact',
    coordinationFunctions,
    jwtClaims: {
      scope: { type: 'workspace' },
      workflow_id: input.workflow.id,
      workflow_version: input.workflow.version,
      agent_id: input.entryAgent.id,
      agent_version: input.entryAgent.version,
      ...(input.triggerId ? { trigger_id: input.triggerId } : {}),
      permissions: {
        allowed_tools: effectiveTools,
        allowed_tool_refs: effectiveRefs.map((ref) => ({ server_id: ref.serverId, tool_name: ref.toolName })),
        allowed_tool_operations: toolOperations,
        context_grants: contextGrants,
        ...(input.exactRepository ? {
          allowed_repository: {
            provider: input.exactRepository.provider,
            repository: input.exactRepository.repository,
            ...(input.exactRepository.ref ? { ref: input.exactRepository.ref } : {}),
            ...(input.exactRepository.changeRequestNumber
              ? { change_request_number: input.exactRepository.changeRequestNumber }
              : {})
          }
        } : {})
      }
    }
  };
}

export function compileWorkflowSessionCeiling(input: Omit<CompileWorkflowAccessInput, 'mappings' | 'exactTargets'>): CompiledWorkflowAccessScope {
  const requiredPermissions = requiredPermissionsFor(input.workflow);
  const missingPermissions = requiredPermissions.filter((permission) => !input.actor.permissions[permission]);
  if (missingPermissions.length) {
    throw new WorkflowAccessDeniedError('WORKFLOW_PERMISSION_DENIED', 'Current workspace role cannot run this workflow.', { missingPermissions });
  }
  if (input.entryAgent.workspaceId !== input.workflow.workspaceId
    || input.entryAgent.id !== input.workflow.entryAgentId
    || input.entryAgent.status !== 'active'
    || input.entryAgent.reviewState !== 'reviewed') {
    throw new WorkflowAccessDeniedError('WORKFLOW_AGENT_SCOPE_DENIED', 'Workflow routing for the selected Agents is unavailable.');
  }
  const requestedContext = uniqueSorted(input.workflow.capabilityPolicy.contextGrants);
  const approvedContext = new Set(input.approvedContextGrants);
  const missingContextGrants = requestedContext.filter((grant) => !approvedContext.has(grant));
  if (missingContextGrants.length) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_CONTEXT_GRANT_DENIED',
      'Workflow context grants require explicit server-side approval.',
      { missingContextGrants }
    );
  }
  const selectedAgents = input.selectedAgents?.length ? input.selectedAgents : [input.entryAgent];
  const semanticCapabilityIds = resolveEffectiveWorkflowCapabilityIds(input.workflow.capabilityPolicy, selectedAgents);
  const principal = input.principal || { type: 'user' as const, id: input.actor.userId };
  return {
    workflowId: input.workflow.id,
    workspaceId: input.workflow.workspaceId,
    workflowVersion: input.workflow.version,
    actor: { userId: input.actor.userId, role: input.actor.role },
    mode: input.workflow.capabilityPolicy.mode,
    semanticCapabilityIds,
    capabilityRestrictionMode: input.workflow.capabilityPolicy.restrictionMode === 'inherit' ? 'inherit' : 'restrict',
    requiredPermissions,
    grantedCapabilities: requiredPermissions,
    mcpServers: [], mcpTools: [], targetToolRefs: [], tools: [], toolOperations: {}, enabledSkills: [],
    contextGrants: requestedContext,
    approvalGates: uniqueSorted(input.workflow.capabilityPolicy.approvalRequirements),
    permissionMode: input.workflow.capabilityPolicy.mode === 'read_only' ? 'read_only' : input.entryAgent.permissionMode,
    principal,
    entryAgent: { id: input.entryAgent.id, version: input.entryAgent.version, kind: input.entryAgent.kind },
    exactTargets: [],
    resourceResolutionPhase: 'session_ceiling',
    coordinationFunctions: input.entryAgent.kind === 'manager' ? [...MANAGER_COORDINATION_FUNCTIONS] : [],
    jwtClaims: {
      scope: { type: 'workspace' }, workflow_id: input.workflow.id, workflow_version: input.workflow.version,
      agent_id: input.entryAgent.id, agent_version: input.entryAgent.version,
      permissions: { allowed_tools: [], allowed_tool_refs: [], allowed_tool_operations: {}, context_grants: requestedContext }
    }
  };
}

export function selectDelegationCandidate(input: {
  manager: AgentDefinition;
  workflow: WorkflowDefinitionForAccess;
  capabilityId: string;
  target: { id: string; targetType: 'kubernetes' | 'virtual_machine' };
  agents: AgentDefinition[];
  mappings: CapabilityRoutingMapping[];
}): { agent: AgentDefinition; mapping: CapabilityRoutingMapping } | null {
  const workflowRestriction = new Set(input.workflow.delegationPolicy?.specialistAgentIds || []);
  const managerAllowlist = new Set(input.manager.delegateAgentIds);
  return input.mappings
    .filter((mapping) => mapping.capabilityId === input.capabilityId
      && (mapping.invocationScopes || ['agent', 'workflow']).includes('workflow')
      && mappingCompatible(mapping, [input.target]))
    .map((mapping) => ({
      mapping,
      agent: input.agents.find((agent) => (
        agent.id === mapping.agentId
        && agent.version === mapping.agentVersion
        && agent.kind === 'specialist'
        && agent.status === 'active'
        && agent.reviewState === 'reviewed'
      ))
    }))
    .filter((candidate): candidate is { mapping: CapabilityRoutingMapping; agent: AgentDefinition } => Boolean(candidate.agent))
    .filter(({ agent }) => managerAllowlist.has(agent.id))
    .filter(({ agent }) => workflowRestriction.size === 0 || workflowRestriction.has(agent.id))
    .filter(({ agent }) => (
      (!agent.targetScope.targetIds?.length || agent.targetScope.targetIds.includes(input.target.id))
      && (!agent.targetScope.targetTypes?.length || agent.targetScope.targetTypes.includes(input.target.targetType))
    ))
    .sort((left, right) => left.mapping.priority - right.mapping.priority || left.agent.id.localeCompare(right.agent.id))[0] || null;
}
