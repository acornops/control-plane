import type { WorkspaceCapability } from '../auth/authorization.js';
import type { WorkspaceAuditOperation } from '../types/domain.js';
import type {
  AgentAccessActor,
  AgentDefinition,
  CompiledAgentRunScope,
  RunPrincipalRef
} from '../types/agents.js';
import type { CapabilityRoutingMapping } from '../types/capability-routing.js';
import { MANAGER_COORDINATION_FUNCTIONS } from './coordination-functions.js';
import {
  capabilityRequiresExactTarget,
  targetAllowedByAgentScope,
  targetAllowedByMapping,
  type ExactTargetBinding
} from './target-scope-authorization.js';

export type AgentAccessDeniedCode =
  | 'AGENT_DISABLED'
  | 'AGENT_PERMISSION_DENIED'
  | 'AGENT_CONTEXT_GRANT_DENIED'
  | 'AGENT_CAPABILITY_MAPPING_UNAVAILABLE'
  | 'AGENT_TARGET_REQUIRED'
  | 'AGENT_TARGET_SCOPE_DENIED';

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
  principal?: RunPrincipalRef;
  mappings?: CapabilityRoutingMapping[];
  invocationScope?: 'agent' | 'workflow';
  exactTarget?: ExactTargetBinding;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function compileToolOperations(tools: string[]): Record<string, WorkspaceAuditOperation> {
  return Object.fromEntries(tools.map((tool) => [tool,
    /(?:\.create|\.update|\.delete|\.write|\.generate)$/.test(tool) ? 'write' : 'read'
  ] as const));
}

function approvalGatesFor(agent: AgentDefinition): string[] {
  if (agent.permissionMode === 'read_only') return ['Writes are disabled'];
  if (agent.permissionMode === 'ask_before_changes') return ['Before every write-capable tool'];
  if (agent.permissionMode === 'auto_allowed_changes') return ['Before high-risk or destructive writes'];
  if (agent.approvalPolicy.mode === 'always') return ['Before every tool call'];
  if (agent.approvalPolicy.mode === 'before_write' || agent.approvalPolicy.writeToolsRequireApproval) {
    return ['Before write-capable tools'];
  }
  return [];
}

export function compileAgentRunScope(input: CompileAgentRunScopeInput): CompiledAgentRunScope {
  if (input.agent.status !== 'active' || input.agent.reviewState !== 'reviewed') {
    throw new AgentAccessDeniedError('AGENT_DISABLED', 'Agent is not active.');
  }

  const manager = input.agent.kind === 'manager';
  const requiresTarget = input.agent.semanticCapabilityIds.some(capabilityRequiresExactTarget);
  if (requiresTarget && !input.exactTarget) {
    throw new AgentAccessDeniedError('AGENT_TARGET_REQUIRED', 'This Agent capability requires one exact target.');
  }
  if (input.exactTarget && !targetAllowedByAgentScope(input.agent.targetScope, input.exactTarget)) {
    throw new AgentAccessDeniedError('AGENT_TARGET_SCOPE_DENIED', 'The selected target is outside this Agent scope.');
  }
  const mappings = manager ? [] : input.agent.semanticCapabilityIds.map((capabilityId) => {
    const mapping = (input.mappings || []).find((candidate) => (
      candidate.capabilityId === capabilityId
      && candidate.agentId === input.agent.id
      && candidate.agentVersion === input.agent.version
      && candidate.status === 'active'
      && candidate.reviewState === 'reviewed'
      && (candidate.invocationScopes || ['agent', 'workflow']).includes(input.invocationScope || 'agent')
      && (!input.exactTarget || targetAllowedByMapping(candidate, input.exactTarget))
      && (input.exactTarget || candidate.targetIds.length === 0)
    ));
    if (!mapping) {
      throw new AgentAccessDeniedError(
        'AGENT_CAPABILITY_MAPPING_UNAVAILABLE',
        `No active reviewed exact-resource mapping is available for ${capabilityId}.`
      );
    }
    return mapping;
  });
  const directAttachmentMode = !manager && input.agent.semanticCapabilityIds.length === 0;
  const directMcpTools = directAttachmentMode
    ? input.agent.mcpInstallations.flatMap((installation) => {
        if (!installation.enabled) return [];
        const constraints = installation.targetConstraints || { targetTypes: [], targetIds: [] };
        if (input.exactTarget && (
          (constraints.targetIds.length > 0 && !constraints.targetIds.includes(input.exactTarget.id))
          || (constraints.targetTypes.length > 0 && !constraints.targetTypes.includes(input.exactTarget.targetType))
        )) return [];
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
  const mappedMcpTools = [...directMcpTools, ...mappings.flatMap((mapping) => mapping.mcpTools)]
    .filter((tool, index, tools) => tools.findIndex((candidate) => (
      candidate.serverId === tool.serverId && candidate.toolName === tool.toolName
    )) === index)
    .filter((tool) => input.agent.permissionMode !== 'read_only' || tool.operation === 'read');
  const targetToolRefs = mappings.flatMap((mapping) => mapping.targetToolRefs || [])
    .filter((tool, index, tools) => tools.findIndex((candidate) => (
      candidate.serverId === tool.serverId && candidate.toolName === tool.toolName
    )) === index)
    .filter((tool) => input.agent.permissionMode !== 'read_only' || tool.operation === 'read');
  const localTools = uniqueSorted([
    ...(directAttachmentMode ? input.agent.tools : []),
    ...mappings.flatMap((mapping) => mapping.nativeToolIds)
  ])
    .filter((tool) => input.agent.permissionMode !== 'read_only' || compileToolOperations([tool])[tool] === 'read');
  const remoteOperations = Object.fromEntries(
    [...mappedMcpTools, ...targetToolRefs].map((tool) => [tool.alias, tool.operation] as const)
  );
  const operations = { ...compileToolOperations(localTools), ...remoteOperations };
  const runCapability: WorkspaceCapability = Object.values(operations).includes('write')
    ? 'create_read_write_runs'
    : 'create_read_only_runs';
  const missingPermissions = (['read_workspace_data', runCapability] as WorkspaceCapability[])
    .filter((permission) => !input.actor.permissions[permission]);
  if (missingPermissions.length > 0) {
    throw new AgentAccessDeniedError(
      'AGENT_PERMISSION_DENIED',
      'Current workspace role cannot run this agent.',
      { missingPermissions }
    );
  }

  const contextGrants = uniqueSorted([
    ...(directAttachmentMode ? input.agent.contextGrants : []),
    ...mappings.flatMap((mapping) => mapping.contextGrants)
  ]);
  const approvedContextGrants = new Set(input.approvedContextGrants);
  const missingContextGrants = contextGrants.filter((grant) => !approvedContextGrants.has(grant));
  if (missingContextGrants.length > 0) {
    throw new AgentAccessDeniedError(
      'AGENT_CONTEXT_GRANT_DENIED',
      'Agent context grants require explicit server-side approval.',
      { missingContextGrants }
    );
  }

  const tools = uniqueSorted([...localTools, ...mappedMcpTools.map((tool) => tool.alias), ...targetToolRefs.map((tool) => tool.alias)]);
  const toolOperations = { ...compileToolOperations(localTools), ...remoteOperations };
  const mcpTools = mappedMcpTools.map((ref) => ({ serverId: ref.serverId, toolName: ref.toolName }));
  const principal = input.principal || { type: 'user' as const, id: input.actor.userId };
  return {
    agentId: input.agent.id,
    workspaceId: input.agent.workspaceId,
    agentVersion: input.agent.version,
    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    actor: {
      userId: input.actor.userId,
      role: input.actor.role
    },
    mcpServers: uniqueSorted(mcpTools.map((ref) => ref.serverId)),
    mcpTools,
    targetToolRefs: targetToolRefs.map((ref) => ({ serverId: ref.serverId, toolName: ref.toolName })),
    tools,
    toolOperations,
    enabledSkills: uniqueSorted([
      ...(directAttachmentMode
        ? input.agent.skillInstallations.filter((skill) => skill.enabled).map((skill) => skill.id)
        : []),
      ...mappings.flatMap((mapping) => mapping.skillIds)
    ]),
    contextGrants,
    approvalGates: approvalGatesFor(input.agent),
    permissionMode: input.agent.permissionMode,
    semanticCapabilityIds: uniqueSorted(input.agent.semanticCapabilityIds),
    coordinationFunctions: manager ? [...MANAGER_COORDINATION_FUNCTIONS] : [],
    principal,
    targetScope: {
      type: input.agent.targetScope.type,
      ...(input.agent.targetScope.targetTypes ? { targetTypes: [...input.agent.targetScope.targetTypes] } : {}),
      ...(input.agent.targetScope.targetIds ? { targetIds: [...input.agent.targetScope.targetIds] } : {})
    },
    exactTargets: input.exactTarget ? [input.exactTarget] : [],
    resourceResolutionPhase: 'run_exact',
    jwtClaims: {
      scope: { type: 'workspace' },
      agent_id: input.agent.id,
      agent_version: input.agent.version,
      ...(input.triggerId ? { trigger_id: input.triggerId } : {}),
      permissions: {
        allowed_tools: tools,
        allowed_tool_refs: mcpTools.map((ref) => ({ server_id: ref.serverId, tool_name: ref.toolName })),
        allowed_tool_operations: toolOperations,
        context_grants: contextGrants
      }
    }
  };
}
