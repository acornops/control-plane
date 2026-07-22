import { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { getWorkflowOptionsCatalog, listWorkflowDefinitions } from '../store/repository-workflows.js';
import type { AgentCapability, AgentDefinition, AgentDefinitionResponse, AgentTriggerType } from '../types/agents.js';
import { TARGET_TYPES, type TargetType } from '../types/domain.js';
import { repo } from '../store/repository.js';

const AGENT_TRIGGER_TYPES: AgentTriggerType[] = [
  'manual',
  'workflow',
  'schedule',
  'webhook',
  'target_event'
];

const KNOWN_CONTEXT_GRANTS = new Set([
  'workspace_metadata',
  'audit_events',
  'target_inventory'
]);

export function requireAgentWorkspaceId(req: AuthenticatedRequest, res: Response): string | null {
  const raw = req.body?.workspaceId || req.query.workspaceId;
  const workspaceId = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  if (!workspaceId) {
    res.status(400).json({ error: {
      code: 'AGENT_WORKSPACE_REQUIRED',
      message: 'workspaceId is required for workspace-scoped agent routes.',
      retryable: false
    } });
  }
  return workspaceId;
}

export async function auditAgentDefinitionMutation(
  req: AuthenticatedRequest,
  agent: AgentDefinition,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await recordWorkspaceAuditEvent({
    workspaceId: agent.workspaceId, category: 'run', eventType, operation: 'write',
    actorUserId: req.auth.userId, objectType: 'agent', objectId: agent.id,
    objectName: agent.name, summary,
    metadata: { agentId: agent.id, agentVersion: agent.version, status: agent.status, ...metadata }
  });
}

export function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

export function agentPatch(body: Record<string, unknown>): Partial<AgentDefinition> {
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    description: typeof body.description === 'string' ? body.description : undefined,
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
    status: body.status === 'active' || body.status === 'disabled' || body.status === 'draft' ? body.status : undefined,
    kind: body.kind === 'manager' || body.kind === 'specialist' ? body.kind : undefined,
    reviewState: body.reviewState === 'draft' || body.reviewState === 'reviewed' ? body.reviewState : undefined,
    providerType: body.providerType === 'internal' || body.providerType === 'external' ? body.providerType : undefined,
    ownerUserId: typeof body.ownerUserId === 'string' ? body.ownerUserId : undefined,
    tools: stringList(body.tools),
    contextGrants: stringList(body.contextGrants),
    approvalPolicy: body.approvalPolicy && typeof body.approvalPolicy === 'object' && !Array.isArray(body.approvalPolicy)
      ? body.approvalPolicy as AgentDefinition['approvalPolicy']
      : undefined,
    trustPolicy: body.trustPolicy && typeof body.trustPolicy === 'object' && !Array.isArray(body.trustPolicy)
      ? body.trustPolicy as AgentDefinition['trustPolicy']
      : undefined,
    targetScope: normalizeTargetScope(body.targetScope),
    permissionMode: body.permissionMode === 'read_only'
      || body.permissionMode === 'ask_before_changes'
      || body.permissionMode === 'auto_allowed_changes'
      ? body.permissionMode
      : undefined,
    semanticCapabilityIds: stringList(body.semanticCapabilityIds),
    delegateAgentIds: stringList(body.delegateAgentIds)
  };
}

export function normalizeApprovalPolicy(value: unknown): AgentDefinition['approvalPolicy'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const policy = value as Partial<AgentDefinition['approvalPolicy']>;
  if (policy.mode !== 'none' && policy.mode !== 'before_write' && policy.mode !== 'always') return undefined;
  return {
    mode: policy.mode,
    writeToolsRequireApproval: policy.writeToolsRequireApproval !== false
  };
}

export function normalizeTrustPolicy(value: unknown, providerType: AgentDefinition['providerType']): AgentDefinition['trustPolicy'] | undefined {
  if (providerType === 'external') {
    return { level: 'restricted', allowExternalData: false };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const policy = value as Partial<AgentDefinition['trustPolicy']>;
  if (policy.level !== 'restricted' && policy.level !== 'trusted') return undefined;
  return {
    level: policy.level,
    allowExternalData: policy.allowExternalData === true
  };
}

export function normalizeTargetScope(value: unknown): AgentDefinition['targetScope'] | undefined {
  if (Array.isArray(value)) {
    const tokens = value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
    const explicitScope = tokens.find((token) => token.startsWith('scope:'))?.slice('scope:'.length);
    const targetTypes = (tokens
      .flatMap((token) => {
        if (token.startsWith('target-type:')) return [token.slice('target-type:'.length)];
        if (token.endsWith(':*')) return [token.slice(0, -2)];
        return [];
      })) as TargetType[];
    const targetIds = tokens
      .flatMap((token) => {
        if (token.startsWith('target:')) return [token.slice('target:'.length)];
        const [kind, id] = token.split(':', 2);
        if (kind && id && id !== '*' && kind !== 'scope' && kind !== 'target-type' && kind !== 'workspace') return [id];
        return [];
      })
      .filter(Boolean);
    const workspaceScoped = explicitScope === 'workspace' || tokens.includes('workspace:current') || tokens.includes('workspace');
    if (workspaceScoped && targetTypes.length === 0 && targetIds.length === 0) return { type: 'workspace' };
    return {
      type: explicitScope === 'workspace' ? 'workspace' : 'selected_target',
      ...(targetTypes.length > 0 ? { targetTypes: [...new Set(targetTypes)] } : {}),
      ...(targetIds.length > 0 ? { targetIds: [...new Set(targetIds)] } : {})
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const scope = value as Partial<AgentDefinition['targetScope']>;
  if (scope.type !== 'workspace' && scope.type !== 'selected_target') return undefined;
  return {
    type: scope.type,
    ...(Array.isArray(scope.targetTypes) ? { targetTypes: scope.targetTypes } : {}),
    ...(Array.isArray(scope.targetIds) ? { targetIds: scope.targetIds } : {})
  };
}

export async function collectAgentOptionErrors(workspaceId: string, input: Partial<AgentDefinition>): Promise<string[]> {
  const options = await getWorkflowOptionsCatalog(workspaceId);
  const servers = new Map(options.mcpServers.map((option) => [option.value, option]));
  const tools = new Map(options.mcpTools.map((option) => [option.value, option]));
  const skills = new Map(options.skills.map((option) => [option.value, option]));
  const targetTypes = new Set(TARGET_TYPES);
  const errors: string[] = [];

  for (const server of input.mcpServers || []) {
    const option = servers.get(server);
    if (!option) errors.push(`Unknown MCP server: ${server}`);
    else if (option.disabled) errors.push(`Disabled MCP server: ${server}`);
  }
  for (const tool of input.tools || []) {
    const option = tools.get(tool);
    if (!option) errors.push(`Unknown tool: ${tool}`);
    else if (option.disabled) errors.push(`Disabled tool: ${tool}`);
  }
  for (const skill of input.skills || []) {
    const option = skills.get(skill);
    if (!option) errors.push(`Unknown skill: ${skill}`);
    else if (option.disabled) errors.push(`Disabled skill: ${skill}`);
  }
  for (const grant of input.contextGrants || []) {
    if (!KNOWN_CONTEXT_GRANTS.has(grant)) errors.push(`Unknown context grant: ${grant}`);
  }
  for (const targetType of input.targetScope?.targetTypes || []) {
    if (!targetTypes.has(targetType)) errors.push(`Unknown target type: ${targetType}`);
  }
  for (const targetId of input.targetScope?.targetIds || []) {
    const target = await repo.getTarget(workspaceId, targetId);
    if (!target) {
      errors.push(`Unknown target: ${targetId}`);
      continue;
    }
    if (input.targetScope?.targetTypes?.length && !input.targetScope.targetTypes.includes(target.targetType)) {
      errors.push(`Target ${targetId} is not one of the allowed target types.`);
    }
  }
  if (input.trustPolicy && input.trustPolicy.level !== 'restricted' && input.trustPolicy.level !== 'trusted') {
    errors.push('Unknown trust policy level.');
  }
  if (
    input.approvalPolicy &&
    input.approvalPolicy.mode !== 'none' &&
    input.approvalPolicy.mode !== 'before_write' &&
    input.approvalPolicy.mode !== 'always'
  ) {
    errors.push('Unknown approval policy mode.');
  }
  return errors;
}

export function triggerType(value: unknown): AgentTriggerType | null {
  return typeof value === 'string' && AGENT_TRIGGER_TYPES.includes(value as AgentTriggerType)
    ? value as AgentTriggerType
    : null;
}

export function badRequest(res: Response, code: string, message: string, details?: unknown): void {
  res.status(400).json({ error: { code, message, retryable: false, details } });
}

export async function workflowsUsingAgent(workspaceId: string, agentId: string): Promise<string[]> {
  return (await listWorkflowDefinitions(workspaceId))
    .filter((workflow) => workflow.agentIds.includes(agentId))
    .map((workflow) => workflow.name);
}

function writeRequiresApproval(agent: AgentDefinition): boolean {
  return agent.approvalPolicy.mode === 'always' || agent.approvalPolicy.mode === 'before_write' || agent.approvalPolicy.writeToolsRequireApproval;
}

function agentCapabilities(agent: AgentDefinition): AgentCapability[] {
  const capabilities: AgentCapability[] = [];
  for (const server of agent.mcpServers) {
    capabilities.push({ source: 'mcp_tool', resourceType: 'mcp_server', resourceScope: server, operation: 'read', requiresApproval: false });
  }
  for (const tool of agent.tools) {
    capabilities.push({ source: 'builtin_tool', resourceType: 'tool', resourceScope: tool, toolId: tool, operation: 'read', requiresApproval: false });
  }
  for (const skill of agent.skills) {
    capabilities.push({ source: 'skill', resourceType: 'skill', resourceScope: skill, operation: 'read', requiresApproval: false });
  }
  for (const grant of agent.contextGrants) {
    capabilities.push({ source: 'context', resourceType: 'context_grant', resourceScope: grant, operation: 'read', requiresApproval: grant !== 'workspace_metadata' });
  }
  if (agent.targetScope.type === 'workspace' && !agent.targetScope.targetTypes?.length && !agent.targetScope.targetIds?.length) {
    capabilities.push({ source: 'target', resourceType: 'target_scope', resourceScope: 'workspace', operation: 'read', requiresApproval: false });
  }
  for (const targetType of agent.targetScope.targetTypes || []) {
    capabilities.push({ source: 'target', resourceType: 'target_type', resourceScope: targetType, operation: 'read', requiresApproval: false });
  }
  for (const targetId of agent.targetScope.targetIds || []) {
    capabilities.push({ source: 'target', resourceType: 'target', resourceScope: targetId, operation: 'read', requiresApproval: false });
  }
  if (writeRequiresApproval(agent)) {
    for (const tool of agent.tools.filter((tool) => tool.includes('.create') || tool.includes('.update') || tool.includes('.delete') || tool.includes('.write') || tool.includes('.generate'))) {
      capabilities.push({ source: 'builtin_tool', resourceType: 'tool', resourceScope: tool, toolId: tool, operation: 'write', requiresApproval: true });
    }
  }
  return capabilities;
}

export async function agentResponse(agent: AgentDefinition): Promise<AgentDefinitionResponse> {
  const {
    delegateAgentIds: _delegateAgentIds,
    systemRole: _systemRole,
    kind: _kind,
    ...publicAgent
  } = agent;
  return {
    ...publicAgent,
    kind: 'specialist',
    capabilities: agentCapabilities(agent),
    workflowsUsingAgent: await workflowsUsingAgent(agent.workspaceId, agent.id)
  };
}
