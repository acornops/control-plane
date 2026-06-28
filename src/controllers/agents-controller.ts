import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { compileAgentRunScope, AgentAccessDeniedError } from '../services/agent-access.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  createAgentActivityRecord,
  createAgentDefinition,
  createAgentTrigger as createStoredAgentTrigger,
  createAgentVersionSnapshot,
  deleteAgentTrigger as deleteStoredAgentTrigger,
  getAgentDefinition,
  listAgentActivityRecords,
  listAgentDefinitions,
  updateAgentDefinition,
  updateAgentTrigger as updateStoredAgentTrigger
} from '../store/repository-agents.js';
import { getWorkflowOptionsCatalog } from '../store/repository-workflows.js';
import type { AgentDefinition, AgentTriggerType } from '../types/agents.js';
import { TARGET_TYPES } from '../types/domain.js';
import { toSingleParam } from '../utils/params.js';

const AGENT_TRIGGER_TYPES: AgentTriggerType[] = [
  'manual',
  'workflow_step',
  'schedule',
  'webhook',
  'audit_event',
  'target_event',
  'external_adapter'
];

function requestWorkspaceId(req: AuthenticatedRequest): string | null {
  const raw = req.body?.workspaceId || req.query.workspaceId;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function requireAgentWorkspaceId(req: AuthenticatedRequest, res: Response): string | null {
  const workspaceId = requestWorkspaceId(req);
  if (!workspaceId) {
    res.status(400).json({
      error: {
        code: 'AGENT_WORKSPACE_REQUIRED',
        message: 'workspaceId is required for workspace-scoped agent routes.',
        retryable: false
      }
    });
    return null;
  }
  return workspaceId;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function bodyRecord(req: AuthenticatedRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
}

function agentPatch(body: Record<string, unknown>): Partial<AgentDefinition> {
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
    targetScope: body.targetScope && typeof body.targetScope === 'object' && !Array.isArray(body.targetScope)
      ? body.targetScope as AgentDefinition['targetScope']
      : undefined
  };
}

function normalizeApprovalPolicy(value: unknown): AgentDefinition['approvalPolicy'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const policy = value as Partial<AgentDefinition['approvalPolicy']>;
  if (policy.mode !== 'none' && policy.mode !== 'before_write' && policy.mode !== 'always') return undefined;
  return {
    mode: policy.mode,
    writeToolsRequireApproval: policy.writeToolsRequireApproval !== false
  };
}

function normalizeTrustPolicy(value: unknown, providerType: AgentDefinition['providerType']): AgentDefinition['trustPolicy'] | undefined {
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

function normalizeTargetScope(value: unknown): AgentDefinition['targetScope'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const scope = value as Partial<AgentDefinition['targetScope']>;
  if (scope.type !== 'workspace' && scope.type !== 'selected_target') return undefined;
  return {
    type: scope.type,
    ...(Array.isArray(scope.targetTypes) ? { targetTypes: scope.targetTypes } : {}),
    ...(Array.isArray(scope.targetIds) ? { targetIds: scope.targetIds } : {})
  };
}

const KNOWN_CONTEXT_GRANTS = new Set([
  'workspace_metadata',
  'audit_events',
  'selected_chat_sessions',
  'target_inventory'
]);

function collectAgentOptionErrors(workspaceId: string, input: Partial<AgentDefinition>): string[] {
  const options = getWorkflowOptionsCatalog(workspaceId);
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

function triggerType(value: unknown): AgentTriggerType {
  return typeof value === 'string' && AGENT_TRIGGER_TYPES.includes(value as AgentTriggerType)
    ? value as AgentTriggerType
    : 'manual';
}

function badRequest(res: Response, code: string, message: string, details?: unknown): void {
  res.status(400).json({ error: { code, message, retryable: false, details } });
}

export async function listAgents(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    res.status(200).json({ items: listAgentDefinitions(workspaceId) });
  } catch (err) {
    next(err);
  }
}

export async function getAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const agent = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    res.status(200).json({ agent });
  } catch (err) {
    next(err);
  }
}

export async function createAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agents');
    if (!authz) return;
    const body = bodyRecord(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
    if (!name) {
      badRequest(res, 'AGENT_NAME_REQUIRED', 'Agent name is required.');
      return;
    }
    if (!instructions) {
      badRequest(res, 'AGENT_INSTRUCTIONS_REQUIRED', 'Agent instructions are required.');
      return;
    }
    const providerType: AgentDefinition['providerType'] = body.providerType === 'external' ? 'external' : 'internal';
    const approvalPolicy = normalizeApprovalPolicy(body.approvalPolicy);
    const trustPolicy = normalizeTrustPolicy(body.trustPolicy, providerType);
    const targetScope = normalizeTargetScope(body.targetScope);
    const agentInput = {
      providerType,
      mcpServers: stringList(body.mcpServers),
      tools: stringList(body.tools),
      skills: stringList(body.skills),
      contextGrants: stringList(body.contextGrants),
      approvalPolicy,
      trustPolicy,
      targetScope
    };
    const optionErrors = collectAgentOptionErrors(workspaceId, agentInput);
    if (optionErrors.length > 0) {
      badRequest(res, 'AGENT_OPTION_INVALID', 'Agent references unknown or disabled server-owned options.', optionErrors);
      return;
    }
    const agent = createAgentDefinition({
      workspaceId,
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      instructions,
      ownerUserId: typeof body.ownerUserId === 'string' ? body.ownerUserId : req.auth.userId,
      createdBy: req.auth.userId,
      providerType,
      mcpServers: agentInput.mcpServers,
      tools: agentInput.tools,
      skills: agentInput.skills,
      contextGrants: agentInput.contextGrants,
      approvalPolicy,
      trustPolicy,
      targetScope
    });
    await recordWorkspaceAuditEvent({
      workspaceId,
      category: 'run',
      eventType: 'agent.definition_created.v1',
      operation: 'write',
      actorUserId: req.auth.userId,
      objectType: 'agent',
      objectId: agent.id,
      objectName: agent.name,
      summary: 'Agent definition created',
      metadata: { agentId: agent.id, agentVersion: agent.version }
    });
    res.status(201).json({ agent });
  } catch (err) {
    next(err);
  }
}

export async function updateAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agents');
    if (!authz) return;
    const current = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!current) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const patch = agentPatch(bodyRecord(req));
    const optionErrors = collectAgentOptionErrors(workspaceId, { ...current, ...patch });
    if (optionErrors.length > 0) {
      badRequest(res, 'AGENT_OPTION_INVALID', 'Agent references unknown or disabled server-owned options.', optionErrors);
      return;
    }
    const providerType = patch.providerType || current.providerType;
    const updated = updateAgentDefinition(workspaceId, current.id, {
      ...patch,
      trustPolicy: patch.trustPolicy ? normalizeTrustPolicy(patch.trustPolicy, providerType) : patch.providerType === 'external' ? normalizeTrustPolicy(undefined, 'external') : undefined,
      approvalPolicy: patch.approvalPolicy ? normalizeApprovalPolicy(patch.approvalPolicy) : undefined,
      targetScope: patch.targetScope ? normalizeTargetScope(patch.targetScope) : undefined
    });
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    res.status(200).json({ agent: updated });
  } catch (err) {
    next(err);
  }
}

export async function createAgentVersion(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agents');
    if (!authz) return;
    const version = createAgentVersionSnapshot(workspaceId, toSingleParam(req.params.agentId), req.auth.userId);
    if (!version) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    res.status(201).json({ version });
  } catch (err) {
    next(err);
  }
}

export async function testAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to test agents');
    if (!authz) return;
    const agent = getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const body = bodyRecord(req);
    const approvedContextGrants = stringList(body.approvedContextGrants) || [];
    const compiledScope = compileAgentRunScope({
      agent,
      actor: {
        userId: req.auth.userId,
        role: authz.role,
        permissions: authz.permissions
      },
      approvedContextGrants,
      triggerId: typeof body.triggerId === 'string' ? body.triggerId : undefined
    });
    const activity = createAgentActivityRecord({
      agent,
      triggerId: compiledScope.triggerId,
      status: 'queued',
      triggeredBy: { type: 'user', userId: req.auth.userId },
      inputContext: body.inputContext && typeof body.inputContext === 'object' && !Array.isArray(body.inputContext)
        ? body.inputContext as Record<string, unknown>
        : {},
      compiledScope
    });
    res.status(202).json({ activity, compiledScope });
  } catch (err) {
    if (err instanceof AgentAccessDeniedError) {
      res.status(403).json({
        error: {
          code: err.code,
          message: err.message,
          retryable: false,
          details: {
            missingPermissions: err.missingPermissions,
            missingContextGrants: err.missingContextGrants
          }
        }
      });
      return;
    }
    next(err);
  }
}

export async function listAgentActivity(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    res.status(200).json({ items: listAgentActivityRecords(workspaceId, toSingleParam(req.params.agentId)) });
  } catch (err) {
    next(err);
  }
}

export async function createAgentTrigger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agent triggers');
    if (!authz) return;
    const body = bodyRecord(req);
    const trigger = createStoredAgentTrigger(workspaceId, toSingleParam(req.params.agentId), {
      type: triggerType(body.type),
      enabled: body.enabled !== false,
      name: typeof body.name === 'string' ? body.name : undefined,
      schedule: body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule)
        ? body.schedule as { cron: string; timezone: string }
        : undefined,
      eventFilter: body.eventFilter && typeof body.eventFilter === 'object' && !Array.isArray(body.eventFilter)
        ? body.eventFilter as Record<string, unknown>
        : undefined
    });
    if (!trigger) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    res.status(201).json({ trigger });
  } catch (err) {
    next(err);
  }
}

export async function updateAgentTrigger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agent triggers');
    if (!authz) return;
    const body = bodyRecord(req);
    const trigger = updateStoredAgentTrigger(workspaceId, toSingleParam(req.params.agentId), toSingleParam(req.params.triggerId), {
      type: typeof body.type === 'string' ? triggerType(body.type) : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      schedule: body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule)
        ? body.schedule as { cron: string; timezone: string }
        : undefined,
      eventFilter: body.eventFilter && typeof body.eventFilter === 'object' && !Array.isArray(body.eventFilter)
        ? body.eventFilter as Record<string, unknown>
        : undefined
    });
    if (!trigger) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent trigger not found', retryable: false } });
      return;
    }
    res.status(200).json({ trigger });
  } catch (err) {
    next(err);
  }
}

export async function deleteAgentTrigger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = requireAgentWorkspaceId(req, res);
    if (!workspaceId) return;
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agent triggers');
    if (!authz) return;
    if (!deleteStoredAgentTrigger(workspaceId, toSingleParam(req.params.agentId), toSingleParam(req.params.triggerId))) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent trigger not found', retryable: false } });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
