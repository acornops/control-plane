import type { WorkspaceCapability } from '../auth/authorization.js';
import type { WorkspaceAuditOperation } from '../types/domain.js';
import type {
  CompiledWorkflowAccessScope,
  WorkflowAccessActor,
  WorkflowDefinitionForAccess
} from '../types/workflows.js';
import type { AgentDefinition } from '../types/agents.js';

export type WorkflowAccessDeniedCode =
  | 'WORKFLOW_PERMISSION_DENIED'
  | 'WORKFLOW_CONTEXT_GRANT_DENIED'
  | 'WORKFLOW_AGENT_SCOPE_DENIED';

export class WorkflowAccessDeniedError extends Error {
  readonly code: WorkflowAccessDeniedCode;
  readonly missingPermissions: WorkspaceCapability[];
  readonly missingContextGrants: string[];

  constructor(
    code: WorkflowAccessDeniedCode,
    message: string,
    options: {
      missingPermissions?: WorkspaceCapability[];
      missingContextGrants?: string[];
    } = {}
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
  agents?: AgentDefinition[];
  actor: WorkflowAccessActor;
  approvedContextGrants: string[];
  triggerId?: string;
}

export type { WorkflowDefinitionForAccess } from '../types/workflows.js';

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))].sort((left, right) => left.localeCompare(right));
}

function requiredRunCapability(workflow: WorkflowDefinitionForAccess): WorkspaceCapability {
  return workflow.policy.mode === 'read_write' ? 'create_read_write_runs' : 'create_read_only_runs';
}

function requiredPermissionsFor(workflow: WorkflowDefinitionForAccess): WorkspaceCapability[] {
  return uniqueSorted([...workflow.requiredPermissions, requiredRunCapability(workflow)]) as WorkspaceCapability[];
}

function compileToolOperations(tools: string[], mode: WorkflowDefinitionForAccess['policy']['mode']): Record<string, WorkspaceAuditOperation> {
  const operation: WorkspaceAuditOperation = mode === 'read_write' ? 'write' : 'read';
  return Object.fromEntries(tools.map((tool) => [tool, operation]));
}

function compileApprovalGates(workflow: WorkflowDefinitionForAccess): string[] {
  return uniqueSorted([
    ...workflow.policy.approvalRequirements,
    ...workflow.steps
      .filter((step) => step.approvalRequired)
      .map((step) => step.title)
  ]);
}

function intersectOrAgentGrant(stepValues: string[], agentValues: Iterable<string>): string[] {
  const agentSet = new Set(agentValues);
  return uniqueSorted(stepValues.filter((value) => agentSet.has(value)));
}

function activeAgentsForStep(
  workflow: WorkflowDefinitionForAccess,
  agentsById: Map<string, AgentDefinition>,
  stepId: string,
  agentIds: string[]
): AgentDefinition[] {
  const agents = agentIds.map((agentId) => agentsById.get(agentId));
  if (agents.some((agent) => !agent)) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_AGENT_SCOPE_DENIED',
      `Workflow step ${stepId} references an unknown agent.`
    );
  }
  const invalid = agents.find((agent) => agent?.workspaceId !== workflow.workspaceId || agent.status !== 'active');
  if (invalid) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_AGENT_SCOPE_DENIED',
      `Workflow step ${stepId} references an inactive or out-of-workspace agent.`
    );
  }
  return agents as AgentDefinition[];
}

export function compileWorkflowAccessScope(input: CompileWorkflowAccessInput): CompiledWorkflowAccessScope {
  const requiredPermissions = requiredPermissionsFor(input.workflow);
  const missingPermissions = requiredPermissions.filter((permission) => !input.actor.permissions[permission]);
  if (missingPermissions.length > 0) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_PERMISSION_DENIED',
      'Current workspace role cannot run this workflow.',
      { missingPermissions }
    );
  }

  const agentsById = new Map((input.agents || []).map((agent) => [agent.id, agent]));
  const scopedSteps = input.workflow.steps.map((step) => {
    const assignedAgentIds = step.assignedAgentIds || [];
    if (assignedAgentIds.length === 0) {
      return {
        step,
        mcpServers: step.allowedMcpServers,
        tools: step.allowedTools,
        enabledSkills: step.enabledSkills,
        contextGrants: step.contextGrants,
        assignedAgents: [] as AgentDefinition[]
      };
    }
    const assignedAgents = activeAgentsForStep(input.workflow, agentsById, step.id, assignedAgentIds);
    return {
      step,
      mcpServers: intersectOrAgentGrant(step.allowedMcpServers, assignedAgents.flatMap((agent) => agent.mcpServers)),
      tools: intersectOrAgentGrant(step.allowedTools, assignedAgents.flatMap((agent) => agent.tools)),
      enabledSkills: intersectOrAgentGrant(step.enabledSkills, assignedAgents.flatMap((agent) => agent.skills)),
      contextGrants: intersectOrAgentGrant(step.contextGrants, assignedAgents.flatMap((agent) => agent.contextGrants)),
      assignedAgents
    };
  });

  const contextGrants = uniqueSorted(scopedSteps.flatMap((step) => step.contextGrants));
  const approvedContextGrants = new Set(input.approvedContextGrants);
  const missingContextGrants = contextGrants.filter((grant) => !approvedContextGrants.has(grant));
  if (missingContextGrants.length > 0) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_CONTEXT_GRANT_DENIED',
      'Workflow context grants require explicit server-side approval.',
      { missingContextGrants }
    );
  }

  const hasAgentAssignments = scopedSteps.some((step) => step.assignedAgents.length > 0);
  const tools = uniqueSorted(scopedSteps.flatMap((step) => step.tools));
  const workflowMcpServers = input.workflow.enabledMcpServers || [];
  const workflowSkills = input.workflow.enabledSkills || [];
  const toolOperations = compileToolOperations(tools, input.workflow.policy.mode);
  const agentAssignments = scopedSteps
    .filter((step) => step.assignedAgents.length > 0)
    .map((step) => ({
      stepId: step.step.id,
      agentIds: uniqueSorted(step.assignedAgents.map((agent) => agent.id)),
      agentVersions: Object.fromEntries(step.assignedAgents.map((agent) => [agent.id, agent.version]))
    }));
  const singleAssignedAgent = agentAssignments.length === 1 && agentAssignments[0].agentIds.length === 1
    ? input.agents?.find((agent) => agent.id === agentAssignments[0].agentIds[0])
    : undefined;

  return {
    workflowId: input.workflow.id,
    workspaceId: input.workflow.workspaceId,
    workflowVersion: input.workflow.version,
    actor: {
      userId: input.actor.userId,
      role: input.actor.role
    },
    mode: input.workflow.policy.mode,
    requiredPermissions,
    grantedCapabilities: requiredPermissions,
    mcpServers: !hasAgentAssignments && workflowMcpServers.length > 0
      ? uniqueSorted(workflowMcpServers)
      : uniqueSorted(scopedSteps.flatMap((step) => step.mcpServers)),
    tools,
    toolOperations,
    enabledSkills: !hasAgentAssignments && workflowSkills.length > 0
      ? uniqueSorted(workflowSkills)
      : uniqueSorted(scopedSteps.flatMap((step) => step.enabledSkills)),
    contextGrants,
    approvalGates: compileApprovalGates(input.workflow),
    ...(agentAssignments.length > 0 ? { agentAssignments } : {}),
    jwtClaims: {
      scope: { type: 'workspace' },
      workflow_id: input.workflow.id,
      workflow_version: input.workflow.version,
      ...(singleAssignedAgent ? { agent_id: singleAssignedAgent.id, agent_version: singleAssignedAgent.version } : {}),
      ...(input.triggerId ? { trigger_id: input.triggerId } : {}),
      permissions: {
        allowed_tools: tools,
        allowed_tool_operations: toolOperations,
        context_grants: contextGrants
      }
    }
  };
}
