import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../auth/middleware.js';
import { requireWorkspaceCapability, requireWorkspaceDataRead } from '../auth/workspace-authorization.js';
import { recordWorkspaceAuditEvent } from '../services/workspace-audit.js';
import {
  createAgentDefinition,
  getAgentDefinition,
  listAgentDefinitions
} from '../store/repository-agents.js';
import type { AgentDefinition } from '../types/agents.js';
import { toSingleParam } from '../utils/params.js';
import { containsSearchText, makeQuerySignature, normalizeSearchQuery, pageArray, parseBoundedLimit } from '../utils/pagination.js';
import {
  agentPatch,
  agentResponse,
  auditAgentDefinitionMutation,
  badRequest,
  bodyRecord,
  collectAgentOptionErrors,
  normalizeAgentAvatarEmoji,
  normalizeApprovalPolicy,
  normalizeTrustPolicy,
  requireAgentWorkspaceId,
  stringList,
} from './agent-controller-helpers.js';
import {
  createAgentThroughDefinitionService,
  DefinitionValidationError,
  updateAgentThroughDefinitionService
} from '../services/automation-definition-service.js';

export { deleteAgent, duplicateAgent } from './agents-lifecycle-controller.js';

function definitionValidationError(res: Response, error: DefinitionValidationError): void {
  res.status(400).json({
    error: { code: error.code, message: error.message, retryable: false, details: error.details }
  });
}

export async function listAgents(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceDataRead(req, res, workspaceId);
    if (!authz) return;
    const includeInactive = req.query.includeInactive === 'true' || req.query.includeInactive === '1';
    const q = normalizeSearchQuery(req.query.q);
    const signature = makeQuerySignature({ workspaceId, includeInactive, q });
    const agents = (await listAgentDefinitions(workspaceId, { includeInactive }))
      .filter((agent) => containsSearchText([agent.name, agent.description, agent.status, agent.ownerUserId], q));
    const rows = await Promise.all(agents.map(agentResponse));
    res.status(200).json(pageArray(rows, {
      limit: parseBoundedLimit(req.query.limit),
      cursor: req.query.cursor,
      signature
    }));
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
    const agent = await getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!agent) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    res.status(200).json({ agent: await agentResponse(agent) });
  } catch (err) {
    next(err);
  }
}

export async function createAgent(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const workspaceId = toSingleParam(req.params.workspaceId);
    const authz = await requireWorkspaceCapability(req, res, workspaceId, 'manage_agents', 'No permission to manage agents');
    if (!authz) return;
    const body = bodyRecord(req.body);
    const capabilityKeys = ['mcpServers', 'mcpTools', 'mcpInstallations', 'tools', 'nativeToolConfigs', 'skills', 'skillInstallations'];
    if (capabilityKeys.some((key) => body[key] !== undefined)) {
      badRequest(res, 'AGENT_CAPABILITY_ROUTE_REQUIRED', 'Install MCP servers, native tools, and skills through the Agent-scoped capability APIs.');
      return;
    }
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
    const avatarEmoji = normalizeAgentAvatarEmoji(body.avatarEmoji);
    if (body.avatarEmoji !== undefined && !avatarEmoji) {
      badRequest(res, 'AGENT_AVATAR_EMOJI_INVALID', 'Agent avatarEmoji must contain exactly one emoji.');
      return;
    }
    const providerType: AgentDefinition['providerType'] = body.providerType === 'external' ? 'external' : 'internal';
    const approvalPolicy = normalizeApprovalPolicy(body.approvalPolicy);
    const trustPolicy = normalizeTrustPolicy(body.trustPolicy, providerType);
    const agentInput = {
      providerType,
      tools: [],
      contextGrants: stringList(body.contextGrants),
      approvalPolicy,
      trustPolicy
    };
    const optionErrors = await collectAgentOptionErrors(workspaceId, agentInput);
    if (optionErrors.length > 0) {
      badRequest(res, 'AGENT_OPTION_INVALID', 'Agent references unknown or disabled server-owned options.', optionErrors);
      return;
    }
    const agent = await createAgentThroughDefinitionService({
      workspaceId,
      name,
      avatarEmoji,
      description: typeof body.description === 'string' ? body.description : undefined,
      instructions,
      ownerUserId: typeof body.ownerUserId === 'string' ? body.ownerUserId : req.auth.userId,
      createdBy: req.auth.userId,
      reviewState: body.reviewState === 'draft' ? 'draft' : 'reviewed',
      providerType,
      tools: agentInput.tools,
      contextGrants: agentInput.contextGrants,
      approvalPolicy,
      trustPolicy,
      permissionMode: body.permissionMode === 'read_only'
        || body.permissionMode === 'ask_before_changes'
        || body.permissionMode === 'auto_allowed_changes'
        ? body.permissionMode
        : undefined,
      semanticCapabilityIds: stringList(body.semanticCapabilityIds)
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
      metadata: { agentId: agent.id }
    });
    res.status(201).json({ agent: await agentResponse(agent) });
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
    const current = await getAgentDefinition(workspaceId, toSingleParam(req.params.agentId));
    if (!current) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    const body = bodyRecord(req.body);
    const capabilityKeys = ['mcpServers', 'mcpTools', 'mcpInstallations', 'tools', 'nativeToolConfigs', 'skills', 'skillInstallations'];
    if (capabilityKeys.some((key) => body[key] !== undefined)) {
      badRequest(res, 'AGENT_CAPABILITY_ROUTE_REQUIRED', 'Change MCP servers, native tools, and skills through the Agent-scoped capability APIs.');
      return;
    }
    const patch = agentPatch(body);
    if (body.avatarEmoji !== undefined && !patch.avatarEmoji) {
      badRequest(res, 'AGENT_AVATAR_EMOJI_INVALID', 'Agent avatarEmoji must contain exactly one emoji.');
      return;
    }
    const optionErrors = await collectAgentOptionErrors(workspaceId, { ...current, ...patch });
    if (optionErrors.length > 0) {
      badRequest(res, 'AGENT_OPTION_INVALID', 'Agent references unknown or disabled server-owned options.', optionErrors);
      return;
    }
    const providerType = patch.providerType || current.providerType;
    const updated = await updateAgentThroughDefinitionService(workspaceId, current.id, {
      ...patch,
      trustPolicy: patch.trustPolicy ? normalizeTrustPolicy(patch.trustPolicy, providerType) : patch.providerType === 'external' ? normalizeTrustPolicy(undefined, 'external') : undefined,
      approvalPolicy: patch.approvalPolicy ? normalizeApprovalPolicy(patch.approvalPolicy) : undefined
    });
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent not found', retryable: false } });
      return;
    }
    await auditAgentDefinitionMutation(req, updated, 'agent.definition_updated.v1', 'Agent definition updated');
    res.status(200).json({ agent: await agentResponse(updated) });
  } catch (err) {
    if (err instanceof DefinitionValidationError) return definitionValidationError(res, err);
    next(err);
  }
}
