import type { WorkspaceCapability } from '../auth/authorization.js';
import type { AgentDefinition, RunPrincipalRef } from '../types/agents.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import type { WorkspaceAuditOperation } from '../types/domain.js';
import type { PromptResourceBinding } from '../types/prompt-resources.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowAccessActor,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';
import { COORDINATOR_FUNCTIONS } from './coordination-functions.js';
import { resolveEffectiveWorkflowCapabilityIds } from './workflow-capability-policy.js';
import { getWorkspaceNativeTool } from './workspace-native-tools.js';
import { WorkflowAccessDeniedError } from './capability-access-errors.js';

export { WorkflowAccessDeniedError, type WorkflowAccessDeniedCode } from './capability-access-errors.js';


export interface CompileWorkflowAccessInput {
  workflow: WorkflowDefinitionForAccess;
  selectedAgents: AgentDefinition[];
  specialistAgent?: AgentDefinition;
  mappings: CapabilityRoutingMapping[];
  actor: WorkflowAccessActor;
  approvedContextGrants: string[];
  resourceBindings?: PromptResourceBinding[];
  promptDigest?: string;
  bindingDigest?: string;
  triggerId?: string;
  principal?: RunPrincipalRef;
  delegatedSpecialist?: boolean;
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

function workflowToolOperation(
  tool: string,
  mode: WorkflowDefinitionForAccess['capabilityPolicy']['mode']
): WorkspaceAuditOperation {
  if (mode === 'read_only') return 'read';
  const operation = tool.split('.').at(-1)?.toLowerCase() || '';
  return /^(read|list|get|search|query|summarize|describe|inspect|preview|status)$/.test(operation)
    ? 'read'
    : 'write';
}

function assertSelectedAgents(input: CompileWorkflowAccessInput): void {
  const selected = new Set(input.workflow.agentIds);
  if (input.selectedAgents.length !== selected.size || input.selectedAgents.some((agent) => (
    !selected.has(agent.id)
    || agent.workspaceId !== input.workflow.workspaceId
    || agent.status !== 'active'
    || agent.reviewState !== 'reviewed'
  ))) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_AGENT_SCOPE_DENIED',
      'Workflow routing is unavailable because the selected Agents are inactive, unreviewed, or outside this workspace.'
    );
  }
  if (input.specialistAgent && !selected.has(input.specialistAgent.id)) {
    throw new WorkflowAccessDeniedError('WORKFLOW_AGENT_SCOPE_DENIED', 'The specialist is not selected by this Workflow.');
  }
}

function mappingsForSpecialist(
  input: CompileWorkflowAccessInput,
  specialist: AgentDefinition,
  capabilityIds: string[]
): CapabilityRoutingMapping[] {
  return capabilityIds.flatMap((capabilityId) => {
    const mappings = input.mappings.filter((candidate) => (
      candidate.capabilityId === capabilityId
      && candidate.agentId === specialist.id
      && candidate.status === 'active'
      && candidate.reviewState === 'reviewed'
    ));
    if (mappings.length === 0) {
      throw new WorkflowAccessDeniedError(
        'WORKFLOW_CAPABILITY_MAPPING_UNAVAILABLE',
        `No active reviewed mapping is available for ${capabilityId}.`
      );
    }
    return mappings;
  });
}

function validateCommon(input: CompileWorkflowAccessInput): {
  requiredPermissions: WorkspaceCapability[];
  requestedContext: string[];
  principal: RunPrincipalRef;
} {
  const requiredPermissions = requiredPermissionsFor(input.workflow);
  const missingPermissions = requiredPermissions.filter((permission) => !input.actor.permissions[permission]);
  if (missingPermissions.length) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_PERMISSION_DENIED',
      'Current workspace role cannot run this workflow.',
      { missingPermissions }
    );
  }
  assertSelectedAgents(input);
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
  return {
    requiredPermissions,
    requestedContext,
    principal: input.principal || { type: 'user', id: input.actor.userId }
  };
}

export function compileWorkflowAccessScope(input: CompileWorkflowAccessInput): CompiledWorkflowAccessScope {
  const { requiredPermissions, requestedContext, principal } = validateCommon(input);
  const coordinator = !input.specialistAgent;
  const specialist = input.specialistAgent;
  const effectiveCapabilityIds = resolveEffectiveWorkflowCapabilityIds(input.workflow.capabilityPolicy, input.selectedAgents);
  const mappings = specialist ? mappingsForSpecialist(input, specialist, effectiveCapabilityIds) : [];
  const inheritAgentAttachments = Boolean(specialist)
    && input.workflow.capabilityPolicy.restrictionMode === 'inherit';
  const directMcpTools = inheritAgentAttachments
    ? specialist!.mcpInstallations.flatMap((installation) => {
      if (!installation.enabled) return [];
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
  const nativeToolIds = coordinator || input.delegatedSpecialist ? [] : uniqueSorted([
    ...(inheritAgentAttachments ? specialist!.tools : []),
    ...mappings.flatMap((mapping) => mapping.nativeToolIds)
  ]);
  const mode = input.workflow.capabilityPolicy.mode;
  const tools = uniqueSorted([
    ...mcpTools.map((ref) => ref.alias),
    ...nativeToolIds
  ]);
  const toolOperations = {
    ...Object.fromEntries(mcpTools.map((ref) => [ref.alias, ref.operation])),
    ...Object.fromEntries(nativeToolIds.map((tool) => [
      tool,
      getWorkspaceNativeTool(tool)?.approvalOperation || workflowToolOperation(tool, mode)
    ]))
  } as Record<string, WorkspaceAuditOperation>;
  const effectiveTools = tools.filter((tool) => mode === 'read_write' || toolOperations[tool] === 'read');
  const nativeToolConfigs = Object.fromEntries(nativeToolIds
    .filter((toolId) => effectiveTools.includes(toolId) && specialist?.nativeToolConfigs[toolId])
    .map((toolId) => [toolId, structuredClone(specialist!.nativeToolConfigs[toolId])]));
  const effectiveRefs = mcpTools.filter((ref) => mode === 'read_write' || ref.operation === 'read');
  const contextGrants = uniqueSorted([
    ...requestedContext,
    ...(inheritAgentAttachments ? specialist!.contextGrants : []),
    ...mappings.flatMap((mapping) => mapping.contextGrants)
  ]);
  const permissionMode = mode === 'read_only' || !specialist || specialist.permissionMode === 'read_only'
    ? 'read_only'
    : specialist.permissionMode;
  const executor = specialist
    ? { role: 'specialist' as const, agentId: specialist.id }
    : { role: 'coordinator' as const };
  const executorContextGrants = coordinator ? [] : contextGrants;
  const executorResourceBindings = coordinator ? [] : [...(input.resourceBindings || [])];

  return {
    workflowId: input.workflow.id,
    workspaceId: input.workflow.workspaceId,
    actor: { userId: input.actor.userId, role: input.actor.role },
    mode,
    semanticCapabilityIds: coordinator ? [] : effectiveCapabilityIds,
    capabilityRestrictionMode: input.workflow.capabilityPolicy.restrictionMode,
    requiredPermissions,
    grantedCapabilities: requiredPermissions,
    mcpServers: uniqueSorted(effectiveRefs.map((ref) => ref.serverId)),
    mcpTools: effectiveRefs.map((ref) => ({ serverId: ref.serverId, toolName: ref.toolName })),
    tools: effectiveTools,
    toolOperations,
    nativeToolConfigs,
    enabledSkills: coordinator ? [] : uniqueSorted([
      ...(inheritAgentAttachments
        ? specialist!.skillInstallations.filter((skill) => skill.enabled).map((skill) => skill.id)
        : []),
      ...mappings.flatMap((mapping) => mapping.skillIds)
    ]),
    contextGrants: executorContextGrants,
    approvalGates: uniqueSorted(input.workflow.capabilityPolicy.approvalRequirements),
    permissionMode,
    principal,
    executor,
    selectedAgentSnapshots: specialist ? [specialist] : [],
    routingMappingSnapshots: coordinator ? [] : input.mappings,
    resourceBindings: executorResourceBindings,
    promptDigest: input.promptDigest,
    bindingDigest: input.bindingDigest,
    resourceResolutionPhase: 'run_exact',
    coordinationFunctions: coordinator ? [...COORDINATOR_FUNCTIONS] : [],
    jwtClaims: {
      scope: { type: 'workspace' },
      workflow_id: input.workflow.id,
      executor_role: executor.role,
      ...(specialist ? { agent_id: specialist.id } : {}),
      ...(input.triggerId ? { trigger_id: input.triggerId } : {}),
      permissions: {
        allowed_tools: effectiveTools,
        allowed_tool_refs: effectiveRefs.map((ref) => ({ server_id: ref.serverId, tool_name: ref.toolName })),
        allowed_tool_operations: toolOperations,
        context_grants: executorContextGrants,
        resource_bindings: executorResourceBindings.map((binding) => ({
          binding_id: binding.bindingId,
          type: binding.type,
          resource_id: binding.resourceId,
          provider: binding.provider,
          operations: binding.operations
        })),
        binding_digest: input.bindingDigest
      }
    }
  };
}

export function compileWorkflowSessionCeiling(
  input: CompileWorkflowAccessInput
): CompiledWorkflowAccessScope {
  const { requiredPermissions, requestedContext, principal } = validateCommon({ ...input, mappings: [] });
  const specialist = input.workflow.executionMode === 'direct' ? input.selectedAgents[0] : undefined;
  const executor = specialist
    ? { role: 'specialist' as const, agentId: specialist.id }
    : { role: 'coordinator' as const };
  return {
    workflowId: input.workflow.id,
    workspaceId: input.workflow.workspaceId,
    actor: { userId: input.actor.userId, role: input.actor.role },
    mode: input.workflow.capabilityPolicy.mode,
    semanticCapabilityIds: resolveEffectiveWorkflowCapabilityIds(input.workflow.capabilityPolicy, input.selectedAgents),
    capabilityRestrictionMode: input.workflow.capabilityPolicy.restrictionMode,
    requiredPermissions,
    grantedCapabilities: requiredPermissions,
    mcpServers: [], mcpTools: [], tools: [], toolOperations: {},
    nativeToolConfigs: {}, enabledSkills: [],
    contextGrants: requestedContext,
    approvalGates: uniqueSorted(input.workflow.capabilityPolicy.approvalRequirements),
    permissionMode: input.workflow.capabilityPolicy.mode === 'read_only' || !specialist
      ? 'read_only'
      : specialist.permissionMode,
    principal,
    executor,
    selectedAgentSnapshots: input.selectedAgents,
    routingMappingSnapshots: input.mappings,
    resourceBindings: [],
    resourceResolutionPhase: 'session_ceiling',
    coordinationFunctions: executor.role === 'coordinator' ? [...COORDINATOR_FUNCTIONS] : [],
    jwtClaims: {
      scope: { type: 'workspace' },
      workflow_id: input.workflow.id,
      executor_role: executor.role,
      ...(specialist ? { agent_id: specialist.id } : {}),
      permissions: {
        allowed_tools: [], allowed_tool_refs: [], allowed_tool_operations: {},
        context_grants: requestedContext, resource_bindings: []
      }
    }
  };
}

export function selectDelegationCandidate(input: {
  workflow: WorkflowDefinitionForAccess;
  capabilityId: string;
  agents: AgentDefinition[];
  mappings: CapabilityRoutingMapping[];
}): { agent: AgentDefinition; mapping: CapabilityRoutingMapping } | null {
  const selected = new Set(input.workflow.agentIds);
  return input.mappings
    .filter((mapping) => mapping.capabilityId === input.capabilityId
      && mapping.status === 'active'
      && mapping.reviewState === 'reviewed')
    .map((mapping) => ({
      mapping,
      agent: input.agents.find((agent) => (
        agent.id === mapping.agentId
        && selected.has(agent.id)
        && agent.status === 'active'
        && agent.reviewState === 'reviewed'
      ))
    }))
    .filter((candidate): candidate is { mapping: CapabilityRoutingMapping; agent: AgentDefinition } => Boolean(candidate.agent))
    .sort((left, right) => left.mapping.priority - right.mapping.priority || left.agent.id.localeCompare(right.agent.id))[0] || null;
}
