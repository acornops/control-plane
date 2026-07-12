import { Response } from 'express';
import { getWorkflowOptionsCatalog, listWorkflowDefinitions } from '../store/repository-workflows.js';
import type { AgentCapability, AgentDefinition, AgentDefinitionResponse, AgentTriggerType } from '../types/agents.js';
import { TARGET_TYPES, type TargetType } from '../types/domain.js';

const AGENT_TRIGGER_TYPES: AgentTriggerType[] = [
  'manual',
  'workflow_step',
  'schedule',
  'webhook',
  'audit_event',
  'target_event',
  'external_adapter'
];

const KNOWN_CONTEXT_GRANTS = new Set([
  'workspace_metadata',
  'audit_events',
  'selected_chat_sessions',
  'target_inventory'
]);

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
    providerType: body.providerType === 'internal' || body.providerType === 'external' ? body.providerType : undefined,
    ownerUserId: typeof body.ownerUserId === 'string' ? body.ownerUserId : undefined,
    mcpServers: stringList(body.mcpServers),
    tools: stringList(body.tools),
    skills: stringList(body.skills),
    contextGrants: stringList(body.contextGrants),
    approvalPolicy: body.approvalPolicy && typeof body.approvalPolicy === 'object' && !Array.isArray(body.approvalPolicy)
      ? body.approvalPolicy as AgentDefinition['approvalPolicy']
      : undefined,
    trustPolicy: body.trustPolicy && typeof body.trustPolicy === 'object' && !Array.isArray(body.trustPolicy)
      ? body.trustPolicy as AgentDefinition['trustPolicy']
      : undefined,
    targetScope: normalizeTargetScope(body.targetScope)
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
    const targetTypes = tokens
      .flatMap((token) => {
        if (token.startsWith('target-type:')) return [token.slice('target-type:'.length)];
        if (token.endsWith(':*')) return [token.slice(0, -2)];
        return [];
      })
      .filter((targetType): targetType is TargetType => TARGET_TYPES.includes(targetType as TargetType));
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

export function triggerType(value: unknown): AgentTriggerType {
  return typeof value === 'string' && AGENT_TRIGGER_TYPES.includes(value as AgentTriggerType)
    ? value as AgentTriggerType
    : 'manual';
}

export function badRequest(res: Response, code: string, message: string, details?: unknown): void {
  res.status(400).json({ error: { code, message, retryable: false, details } });
}

export function workflowsUsingAgent(workspaceId: string, agentId: string): string[] {
  return listWorkflowDefinitions(workspaceId)
    .filter((workflow) => workflow.steps.some((step) => (step.agentIds || []).includes(agentId)))
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

export function agentResponse(agent: AgentDefinition): AgentDefinitionResponse {
  return {
    ...agent,
    capabilities: agentCapabilities(agent),
    workflowsUsingAgent: workflowsUsingAgent(agent.workspaceId, agent.id)
  };
}
