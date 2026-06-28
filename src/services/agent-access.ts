import type { WorkspaceCapability } from '../auth/authorization.js';
import type { WorkspaceAuditOperation } from '../types/domain.js';
import type {
  AgentAccessActor,
  AgentDefinition,
  CompiledAgentRunScope
} from '../types/agents.js';

export type AgentAccessDeniedCode =
  | 'AGENT_DISABLED'
  | 'AGENT_PERMISSION_DENIED'
  | 'AGENT_CONTEXT_GRANT_DENIED';

export class AgentAccessDeniedError extends Error {
  readonly code: AgentAccessDeniedCode;
  readonly missingPermissions: WorkspaceCapability[];
  readonly missingContextGrants: string[];

  constructor(
    code: AgentAccessDeniedCode,
    message: string,
    options: {
      missingPermissions?: WorkspaceCapability[];
      missingContextGrants?: string[];
    } = {}
  ) {
    super(message);
    this.name = 'AgentAccessDeniedError';
    this.code = code;
    this.missingPermissions = options.missingPermissions || [];
    this.missingContextGrants = options.missingContextGrants || [];
  }
}

export interface CompileAgentRunScopeInput {
  agent: AgentDefinition;
  actor: AgentAccessActor;
  approvedContextGrants: string[];
  triggerId?: string;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function compileToolOperations(tools: string[]): Record<string, WorkspaceAuditOperation> {
  return Object.fromEntries(tools.map((tool) => [tool, 'read' as WorkspaceAuditOperation]));
}

function approvalGatesFor(agent: AgentDefinition): string[] {
  if (agent.approvalPolicy.mode === 'always') return ['Before every tool call'];
  if (agent.approvalPolicy.mode === 'before_write' || agent.approvalPolicy.writeToolsRequireApproval) {
    return ['Before write-capable tools'];
  }
  return [];
}

export function compileAgentRunScope(input: CompileAgentRunScopeInput): CompiledAgentRunScope {
  if (input.agent.status !== 'active') {
    throw new AgentAccessDeniedError('AGENT_DISABLED', 'Agent is not active.');
  }

  const missingPermissions = (['read_workspace_data', 'create_read_only_runs'] as WorkspaceCapability[])
    .filter((permission) => !input.actor.permissions[permission]);
  if (missingPermissions.length > 0) {
    throw new AgentAccessDeniedError(
      'AGENT_PERMISSION_DENIED',
      'Current workspace role cannot run this agent.',
      { missingPermissions }
    );
  }

  const contextGrants = uniqueSorted(input.agent.contextGrants);
  const approvedContextGrants = new Set(input.approvedContextGrants);
  const missingContextGrants = contextGrants.filter((grant) => !approvedContextGrants.has(grant));
  if (missingContextGrants.length > 0) {
    throw new AgentAccessDeniedError(
      'AGENT_CONTEXT_GRANT_DENIED',
      'Agent context grants require explicit server-side approval.',
      { missingContextGrants }
    );
  }

  const tools = uniqueSorted(input.agent.tools);
  const toolOperations = compileToolOperations(tools);
  return {
    agentId: input.agent.id,
    workspaceId: input.agent.workspaceId,
    agentVersion: input.agent.version,
    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    actor: {
      userId: input.actor.userId,
      role: input.actor.role
    },
    mcpServers: uniqueSorted(input.agent.mcpServers),
    tools,
    toolOperations,
    enabledSkills: uniqueSorted(input.agent.skills),
    contextGrants,
    approvalGates: approvalGatesFor(input.agent),
    targetScope: {
      type: input.agent.targetScope.type,
      ...(input.agent.targetScope.targetTypes ? { targetTypes: [...input.agent.targetScope.targetTypes] } : {}),
      ...(input.agent.targetScope.targetIds ? { targetIds: [...input.agent.targetScope.targetIds] } : {})
    },
    jwtClaims: {
      scope: { type: 'workspace' },
      agent_id: input.agent.id,
      agent_version: input.agent.version,
      ...(input.triggerId ? { trigger_id: input.triggerId } : {}),
      permissions: {
        allowed_tools: tools,
        allowed_tool_operations: toolOperations,
        context_grants: contextGrants
      }
    }
  };
}
