import { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import { getCapabilityOptionsCatalog } from '../store/repository-capability-options.js';
import type { AgentDefinitionUpdate } from '../store/repository-agent-types.js';
import type { AgentCapability, AgentDefinition, AgentDefinitionResponse } from '../types/agents.js';

const KNOWN_CONTEXT_GRANTS = new Set([
  'workspace_metadata',
  'audit_events'
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
    metadata: { agentId: agent.id, status: agent.status, ...metadata }
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

export function normalizeAgentAvatarEmoji(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > 64) return undefined;
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized)];
  if (segments.length !== 1) return undefined;
  const isPictograph = /\p{Extended_Pictographic}/u.test(normalized);
  const isFlag = /^\p{Regional_Indicator}{2}$/u.test(normalized);
  const isKeycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(normalized);
  return isPictograph || isFlag || isKeycap ? normalized : undefined;
}

export function agentPatch(body: Record<string, unknown>): AgentDefinitionUpdate {
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    avatarEmoji: normalizeAgentAvatarEmoji(body.avatarEmoji),
    description: typeof body.description === 'string' ? body.description : undefined,
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
    status: body.status === 'active' || body.status === 'disabled' || body.status === 'draft' ? body.status : undefined,
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
    permissionMode: body.permissionMode === 'read_only'
      || body.permissionMode === 'ask_before_changes'
      || body.permissionMode === 'auto_allowed_changes'
      ? body.permissionMode
      : undefined,
    semanticCapabilityIds: stringList(body.semanticCapabilityIds)
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

export async function collectAgentOptionErrors(workspaceId: string, input: Partial<AgentDefinition>): Promise<string[]> {
  const options = await getCapabilityOptionsCatalog(workspaceId);
  const servers = new Map(options.mcpServers.map((option) => [option.value, option]));
  const tools = new Map(options.mcpTools.map((option) => [option.value, option]));
  const skills = new Map(options.skills.map((option) => [option.value, option]));
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

export function badRequest(res: Response, code: string, message: string, details?: unknown): void {
  res.status(400).json({ error: { code, message, retryable: false, details } });
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
  if (writeRequiresApproval(agent)) {
    for (const tool of agent.tools.filter((tool) => tool.includes('.create') || tool.includes('.update') || tool.includes('.delete') || tool.includes('.write') || tool.includes('.generate'))) {
      capabilities.push({ source: 'builtin_tool', resourceType: 'tool', resourceScope: tool, toolId: tool, operation: 'write', requiresApproval: true });
    }
  }
  return capabilities;
}

export async function agentResponse(agent: AgentDefinition): Promise<AgentDefinitionResponse> {
  return {
    ...agent,
    capabilities: agentCapabilities(agent)
  };
}
