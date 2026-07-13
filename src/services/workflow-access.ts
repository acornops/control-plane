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

export function workflowToolOperation(
  tool: string,
  mode: WorkflowDefinitionForAccess['policy']['mode']
): WorkspaceAuditOperation {
  if (mode === 'read_only') return 'read';
  const operation = tool.split('.').at(-1)?.toLowerCase() || '';
  return /^(read|list|get|search|query|summarize|describe|inspect|preview|status)$/.test(operation)
    ? 'read'
    : 'write';
}

function compileToolOperations(tools: string[], mode: WorkflowDefinitionForAccess['policy']['mode']): Record<string, WorkspaceAuditOperation> {
  return Object.fromEntries(tools.map((tool) => [tool, workflowToolOperation(tool, mode)]));
}

function compileApprovalGates(workflow: WorkflowDefinitionForAccess): string[] {
  return uniqueSorted([
    ...workflow.policy.approvalRequirements,
    ...workflow.steps
      .filter((step) => step.approvalRequired)
      .map((step) => step.title)
  ]);
}

function restrictOrInheritAgentGrant(stepValues: string[], agentValues: Iterable<string>): string[] {
  const agentSet = new Set(agentValues);
  if (stepValues.length === 0) return uniqueSorted(agentSet);
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
  const invalid = agents.find((agent) => agent?.workspaceId !== workflow.workspaceId || agent.status !== 'active' || agent.kind !== 'specialist_agent');
  if (invalid) {
    throw new WorkflowAccessDeniedError(
      'WORKFLOW_AGENT_SCOPE_DENIED',
      `Workflow step ${stepId} references an inactive, incompatible, or out-of-workspace agent.`
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
    const agentIds = step.agentIds || [];
    if (agentIds.length === 0) {
      return {
        step,
        mcpServers: step.allowedMcpServers,
        tools: step.allowedTools,
        enabledSkills: step.enabledSkills,
        contextGrants: step.contextGrants,
        selectedAgents: [] as AgentDefinition[]
      };
    }
    if (agentIds.length > 1) {
      throw new WorkflowAccessDeniedError(
        'WORKFLOW_AGENT_SCOPE_DENIED',
        `Workflow step ${step.id} must select exactly one Agent.`
      );
    }
    const selectedAgents = activeAgentsForStep(input.workflow, agentsById, step.id, agentIds);
    const grantedServers = new Set(selectedAgents.flatMap((agent) => agent.mcpServers));
    const grantedTools = new Set(selectedAgents.flatMap((agent) => agent.tools));
    const staleServer = step.allowedMcpServers.find((server) => !grantedServers.has(server));
    const staleTool = step.allowedTools.find((tool) => !grantedTools.has(tool));
    if (staleServer || staleTool) {
      throw new WorkflowAccessDeniedError(
        'WORKFLOW_AGENT_SCOPE_DENIED',
        staleServer
          ? `Workflow step ${step.id} references MCP server ${staleServer}, which is no longer granted by its selected agent.`
          : `Workflow step ${step.id} references MCP tool ${staleTool}, which is no longer granted by its selected agent.`
      );
    }
    return {
      step,
      mcpServers: restrictOrInheritAgentGrant(step.allowedMcpServers, selectedAgents.flatMap((agent) => agent.mcpServers)),
      tools: restrictOrInheritAgentGrant(step.allowedTools, selectedAgents.flatMap((agent) => agent.tools)),
      enabledSkills: restrictOrInheritAgentGrant(step.enabledSkills, selectedAgents.flatMap((agent) => agent.skills)),
      contextGrants: restrictOrInheritAgentGrant(step.contextGrants, selectedAgents.flatMap((agent) => agent.contextGrants)),
      selectedAgents
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

  const hasSelectedAgents = scopedSteps.some((step) => step.selectedAgents.length > 0);
  const tools = uniqueSorted(scopedSteps.flatMap((step) => step.tools));
  const workflowMcpServers = input.workflow.enabledMcpServers || [];
  const workflowSkills = input.workflow.enabledSkills || [];
  const toolOperations = compileToolOperations(tools, input.workflow.policy.mode);
  const selectedAgents = scopedSteps
    .filter((step) => step.selectedAgents.length > 0)
    .map((step) => ({
      stepId: step.step.id,
      agentIds: uniqueSorted(step.selectedAgents.map((agent) => agent.id)),
      agentVersions: Object.fromEntries(step.selectedAgents.map((agent) => [agent.id, agent.version]))
    }));

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
    mcpServers: !hasSelectedAgents && workflowMcpServers.length > 0
      ? uniqueSorted(workflowMcpServers)
      : uniqueSorted(scopedSteps.flatMap((step) => step.mcpServers)),
    tools,
    toolOperations,
    enabledSkills: !hasSelectedAgents && workflowSkills.length > 0
      ? uniqueSorted(workflowSkills)
      : uniqueSorted(scopedSteps.flatMap((step) => step.enabledSkills)),
    contextGrants,
    approvalGates: compileApprovalGates(input.workflow),
    ...(selectedAgents.length > 0 ? { selectedAgents } : {}),
    jwtClaims: {
      scope: { type: 'workspace' },
      workflow_id: input.workflow.id,
      workflow_version: input.workflow.version,
      ...(input.triggerId ? { trigger_id: input.triggerId } : {}),
      permissions: {
        allowed_tools: tools,
        allowed_tool_operations: toolOperations,
        context_grants: contextGrants
      }
    }
  };
}
